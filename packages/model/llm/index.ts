import { GoogleGenAI } from '@google/genai';
import { Database, sessions } from "../db/client";
import { eq, param } from "drizzle-orm";
import * as crypto from 'crypto';
import OpenAI from 'openai';
import { z } from "zod";
import { safeApiCall, classifyError, extractAndParseJson, ClassifiedError } from './safeApiCall';
import { getUserSafeMessage } from './errorMessages';

// ═══════════════════════════════════════════
// MODEL CONFIGURATION
// ═══════════════════════════════════════════

// NVIDIA NIM Provider
const NVIDIA_API_KEY = process.env.NVDIA_KEY ?? "";
const NVIDIA_FALLBACK_MODEL = process.env.NVIDIA_FALLBACK_MODEL ?? process.env.NVIDIA_CODE_MODEL ?? "";
const NVIDIA_MODELS: Record<string, string> = {
    'CLARIFY': process.env.NVIDIA_CLARIFY_MODEL || NVIDIA_FALLBACK_MODEL,
    'PLAN': process.env.NVIDIA_PLAN_MODEL || NVIDIA_FALLBACK_MODEL,
    'CODE': process.env.NVIDIA_CODE_MODEL || NVIDIA_FALLBACK_MODEL,
    'REVIEW': process.env.NVIDIA_REVIEW_MODEL || NVIDIA_FALLBACK_MODEL,
};
const NVIDIA_MODEL_CASCADE = (process.env.NVIDIA_MODEL_CASCADE ?? '').split(',').map(m => m.trim()).filter(Boolean);

// Gemini Pro Provider (Paid Key)
const GEMINI_PRO_API_KEYS = (process.env.GEMINI_PRO_API_KEYS ?? process.env.GEMINI_API_KEYS ?? '').split(',').map(k => k.trim()).filter(Boolean);
const GEMINI_PRO_MODEL_CASCADE = (process.env.GEMINI_PRO_MODEL_CASCADE ?? process.env.GEMINI_MODEL_CASCADE ?? 'gemini-3.1-pro-preview,gemini-2.5-pro,gemini-3.5-flash').split(',').map(m => m.trim()).filter(Boolean);
const GEMINI_PRO_FALLBACK_MODEL = process.env.GEMINI_PRO_FALLBACK_MODEL ?? process.env.GEMINI_FALLBACK_MODEL ?? process.env.GEMINI_PRO_CODE_MODEL ?? process.env.GEMINI_CODE_MODEL ?? "gemini-2.5-pro";
const GEMINI_PRO_MODELS: Record<string, string> = {
    'CLARIFY': process.env.GEMINI_PRO_CLARIFY_MODEL || process.env.GEMINI_CLARIFY_MODEL || GEMINI_PRO_FALLBACK_MODEL,
    'PLAN': process.env.GEMINI_PRO_PLAN_MODEL || process.env.GEMINI_PLAN_MODEL || GEMINI_PRO_FALLBACK_MODEL,
    'CODE': process.env.GEMINI_PRO_CODE_MODEL || process.env.GEMINI_CODE_MODEL || GEMINI_PRO_FALLBACK_MODEL,
    'REVIEW': process.env.GEMINI_PRO_REVIEW_MODEL || process.env.GEMINI_REVIEW_MODEL || GEMINI_PRO_FALLBACK_MODEL,
};

// Gemini Free Provider (Rotated Keys across separate projects)
const GEMINI_FREE_API_KEYS = (process.env.GEMINI_FREE_API_KEYS ?? '').split(',').map(k => k.trim()).filter(Boolean);
const GEMINI_FREE_MODEL_CASCADE = (process.env.GEMINI_FREE_MODEL_CASCADE ?? 'gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.5-flash,gemini-2.5-flash').split(',').map(m => m.trim()).filter(Boolean);
const GEMINI_FREE_FALLBACK_MODEL = process.env.GEMINI_FREE_FALLBACK_MODEL ?? process.env.GEMINI_FREE_CODE_MODEL ?? "gemini-3.5-flash-lite";
const GEMINI_FREE_MODELS: Record<string, string> = {
    'CLARIFY': process.env.GEMINI_FREE_CLARIFY_MODEL || GEMINI_FREE_FALLBACK_MODEL,
    'PLAN': process.env.GEMINI_FREE_PLAN_MODEL || GEMINI_FREE_FALLBACK_MODEL,
    'CODE': process.env.GEMINI_FREE_CODE_MODEL || GEMINI_FREE_FALLBACK_MODEL,
    'REVIEW': process.env.GEMINI_FREE_REVIEW_MODEL || GEMINI_FREE_FALLBACK_MODEL,
};

// Cooldown registry: maps API key string to epoch timestamp (ms) when cooldown ends
const keyCooldowns = new Map<string, number>();

function markKeyCooldown(key: string, cooldownMs: number = 60_000): void {
    keyCooldowns.set(key, Date.now() + cooldownMs);
}

function isKeyCoolingDown(key: string): boolean {
    const expiresAt = keyCooldowns.get(key);
    if (!expiresAt) return false;
    if (Date.now() > expiresAt) {
        keyCooldowns.delete(key);
        return false;
    }
    return true;
}

export interface PrepareParams<T = any> {
    system: string;
    prompt: string;
    mode: 'CLARIFY' | 'PLAN' | 'CODE' | 'REVIEW';
    json?: boolean;
    schema?: z.ZodType<T>;
    sessionId: string;
    stream?: boolean;
    skipCache?: boolean;
}

export interface SimpleKv {
    get(key: string, type: "json"): Promise<any>;
    put(key: string, value: string, options?:
        { expirationTtl?: number }): Promise<any>;
}

export enum Tier {
    FREE = 'FREE',
    PRO = 'PRO'
}

export class LLM {
    public onRetry?: (attempt: number, error: any) => void;
    public lastUsedModel: string = '';
    private geminiKeyIndex: number = 0;
    private nvidiaClient: OpenAI;
    private kv?: SimpleKv;
    private db?: Database;

    public getLastUsedModel(): string {
        return this.lastUsedModel;
    }

    constructor(private tier: Tier = Tier.FREE, kv?: SimpleKv, db?: Database) {
        this.nvidiaClient = new OpenAI({
            baseURL: 'https://integrate.api.nvidia.com/v1',
            apiKey: NVIDIA_API_KEY,
            timeout: 120_000,
        });
        this.db = db;
        this.kv = kv
    }

    private async updateSession(sessionId: string | undefined, data: Partial<typeof sessions.$inferInsert>): Promise<void> {
        if (!sessionId) return;
        if (!this.db) {
            console.warn('[LLM] Cannot update session: Database binding not provided');
            return;
        }
        try {
            await this.db.update(sessions).set(data).where(eq(sessions.id, sessionId));
        } catch (err) {
            console.error(`[LLM] Failed to update session ${sessionId}:`, err);
        }
    }

    private hash(txt: string): string {
        return String(crypto.createHash('sha256').update(txt).digest('hex'));
    }

    private getModelCascade(tier: Tier, mode: 'CLARIFY' | 'PLAN' | 'CODE' | 'REVIEW'): string[] {
        if (tier === Tier.PRO) {
            const primaryModel = GEMINI_PRO_MODELS[mode] || GEMINI_PRO_FALLBACK_MODEL;
            return Array.from(new Set([primaryModel, ...GEMINI_PRO_MODEL_CASCADE])).filter(Boolean);
        } else {
            const primaryModel = GEMINI_FREE_MODELS[mode] || GEMINI_FREE_FALLBACK_MODEL;
            return Array.from(new Set([primaryModel, ...GEMINI_FREE_MODEL_CASCADE])).filter(Boolean);
        }
    }

    private getNextGeminiKey(tier: Tier): string {
        const keys = tier === Tier.PRO ? GEMINI_PRO_API_KEYS : GEMINI_FREE_API_KEYS;
        if (keys.length === 0) return '';

        // Priority 1: Pick non-cooling keys in round-robin fashion
        const activeKeys = keys.filter(k => !isKeyCoolingDown(k));
        if (activeKeys.length > 0) {
            const key = activeKeys[this.geminiKeyIndex % activeKeys.length];
            this.geminiKeyIndex++;
            return key.trim();
        }

        // Priority 2: If all keys are in cooldown, pick the one with earliest expiration
        let bestKey = keys[0];
        let earliestExpiry = Infinity;
        for (const k of keys) {
            const expiry = keyCooldowns.get(k) ?? 0;
            if (expiry < earliestExpiry) {
                earliestExpiry = expiry;
                bestKey = k;
            }
        }
        return bestKey.trim();
    }

    private getTokenLimit(mode: 'CLARIFY' | 'PLAN' | 'CODE' | 'REVIEW'): number {
        return mode === 'CODE' ? 100000 : 32000;
    }

    private getTemperature(mode: 'CLARIFY' | 'PLAN' | 'CODE' | 'REVIEW'): number {
        return mode === 'CODE' ? 0.4 : 0.2;
    }

    private getTimeout(mode: 'CLARIFY' | 'PLAN' | 'CODE' | 'REVIEW'): number {
        switch (mode) {
            case 'CLARIFY': return 45_000;
            case 'PLAN': return 65_000;
            case 'CODE': return 90_000;
            case 'REVIEW': return 45_000;
        }
    }

    private async getFromCache(promptHash: string): Promise<{ response: any; model?: string } | null> {
        try {
            if (!this.kv) return null;

            const key = `llm:${this.tier}:${promptHash}`;
            const cached = await this.kv.get(key, "json");

            if (!cached) return null;
            return {
                response: cached.response,
                model: cached.model
            };
        } catch (err) {
            console.warn('[LLM Cache] Cache lookup failed, proceeding to live generation:', err);
            return null;
        }
    }

    private async saveToCache(promptHash: string, response: any, model: string): Promise<void> {
        try {
            if (!this.kv) return;
            const key = `llm:${this.tier}:${promptHash}`;
            const payload = JSON.stringify({ response, model, tier: this.tier });
            await this.kv.put(key, payload, { expirationTtl: 60 * 60 * 24 * 7 * 4 })
        } catch (err) {
            console.warn('[LLM Cache] Cache write failed:', err);
        }
    }

    // ═══════════════════════════════════════════
    // NVIDIA PROVIDER (Free/NIM Tier)
    // ═══════════════════════════════════════════
    private async generateWithNvidia<T>(params: PrepareParams<T>): Promise<T | AsyncGenerator<string, void, unknown>> {
        const primaryModel = NVIDIA_MODELS[params.mode] || NVIDIA_FALLBACK_MODEL;
        if (!primaryModel) {
            throw new Error(`[LLM Gateway] No NVIDIA model configured for mode '${params.mode}' and no NVIDIA_FALLBACK_MODEL found in environment.`);
        }
        const modelsToTry = Array.from(new Set([primaryModel, ...NVIDIA_MODEL_CASCADE])).filter(Boolean);
        let lastError: ClassifiedError | null = null;

        const promptHash = this.hash(params.system + params.prompt);

        // Safe Cache Lookup before model loop
        if (!params.skipCache) {
            const cacheHit = await this.getFromCache(promptHash);
            if (cacheHit !== null && cacheHit !== undefined) {
                this.lastUsedModel = cacheHit.model || 'cached';
                console.log(`[LLM Cache] Hit for NVIDIA model: ${this.lastUsedModel}`);
                if (params.stream) {
                    if (params.sessionId && params.mode === 'CODE') {
                        await this.updateSession(params.sessionId, { status: 'REVIEW', code: { code: cacheHit.response, model: this.lastUsedModel } });
                    }
                    return (async function* () {
                        yield typeof cacheHit.response === 'string' ? cacheHit.response : JSON.stringify(cacheHit.response);
                    })() as AsyncGenerator<string, void, unknown>;
                } else {
                    if (params.json) {
                        return (typeof cacheHit.response === 'string'
                            ? extractAndParseJson<T>(cacheHit.response, params.schema)
                            : cacheHit.response) as T;
                    }
                    return cacheHit.response as T;
                }
            }
        }

        for (const model of modelsToTry) {
            console.log(`[LLM Gateway] Mode: ${params.mode} -> Trying NVIDIA Model: ${model}`);

            try {
                const useThinking = model.includes("nemotron-3-ultra") || model.includes("deepseek-v4") || model.includes("glm-5.2") || model.includes("thinking");

                if (params.stream) {
                    const apiResult = await safeApiCall(async (signal) => {
                        return await this.nvidiaClient.chat.completions.create({
                            model: model,
                            temperature: this.getTemperature(params.mode),
                            max_tokens: this.getTokenLimit(params.mode),
                            messages: [
                                { role: 'system', content: params.system },
                                { role: 'user', content: params.prompt }
                            ],
                            ...(useThinking ? { chat_template_kwargs: { "enable_thinking": true, "clear_thinking": true } } : {}),
                            stream: true,
                        } as any, { signal } as any);
                    }, { provider: 'nvidia', maxRetries: 2, timeoutMs: this.getTimeout(params.mode) });

                    if (!apiResult.ok) {
                        console.warn(`[NVIDIA Stream Connection] Model ${model} failed: [${apiResult.error.code}] ${apiResult.error.rawMessage}`);
                        lastError = apiResult.error;
                        continue;
                    }

                    const res = apiResult.data as any;
                    let fullRes = '';
                    const self = this;
                    return (async function* () {
                        try {
                            for await (const chunk of res) {
                                const text = chunk.choices[0]?.delta?.content || '';
                                fullRes += text;
                                yield text;
                            }

                            if (!params.skipCache && fullRes.trim()) {
                                await self.saveToCache(promptHash, fullRes, `nvidia:${model}`);
                            }

                            if (params.sessionId && params.mode === 'CODE') {
                                self.lastUsedModel = model;
                                await self.updateSession(params.sessionId, { status: 'REVIEW', code: { code: fullRes, model } });
                            }
                        } catch (streamErr) {
                            console.error("[LLM Gateway] Stream chunk error:", streamErr);
                            const classified = classifyError(streamErr, "nvidia");
                            if (params.sessionId) {
                                await self.updateSession(params.sessionId, { status: 'FAILED', error: classified.userMessage });
                            }
                            throw streamErr;
                        }
                    })();
                } else {
                    const requestParams: any = {
                        model: model,
                        temperature: this.getTemperature(params.mode),
                        max_tokens: this.getTokenLimit(params.mode),
                        messages: [
                            { role: 'system', content: params.system },
                            { role: 'user', content: params.prompt }
                        ],
                        ...(useThinking ? { chat_template_kwargs: { "enable_thinking": true, "clear_thinking": true } } : {})
                    };

                    if (params.json) {
                        requestParams.response_format = { type: 'json_object' };
                    }

                    const timeoutMs = this.getTimeout(params.mode);
                    const apiResult = await safeApiCall<T>(async (signal) => {
                        const res = await this.nvidiaClient.chat.completions.create(requestParams, {
                            signal,
                            timeout: timeoutMs
                        });

                        const content = res.choices[0]?.message?.content;
                        if (!content || !content.trim()) {
                            throw new Error('No content in NVIDIA response');
                        }

                        return content as unknown as T;
                    }, {
                        provider: 'nvidia',
                        schema: params.schema,
                        maxRetries: 2,
                        timeoutMs
                    });

                    if (!apiResult.ok) {
                        console.warn(`[NVIDIA] Model ${model} failed: [${apiResult.error.code}] ${apiResult.error.rawMessage}`);
                        lastError = apiResult.error;
                        continue;
                    }

                    const resultData = apiResult.data;
                    if (!params.skipCache) {
                        await this.saveToCache(promptHash, resultData, `nvidia:${model}`);
                    }

                    return resultData;
                }
            } catch (err: any) {
                console.error(`[LLM Gateway] Model ${model} error:`, err.message || err);
                lastError = classifyError(err, 'nvidia');
            }
        }

        const userMsg = getUserSafeMessage("ALL_EXHAUSTED");
        const cascadeError = new Error(userMsg);
        (cascadeError as any).code = "ALL_EXHAUSTED";
        (cascadeError as any).userMessage = userMsg;
        if (params.sessionId) {
            await this.updateSession(params.sessionId, { status: "FAILED", error: userMsg });
        }
        throw cascadeError;
    }

    // ═══════════════════════════════════════════
    // ═══════════════════════════════════════════
    // GEMINI PROVIDER (Supports Both Free & Pro Tiers)
    // ═══════════════════════════════════════════
    private async generateWithGemini<T>(params: PrepareParams<T>, cascadeIndex = 0): Promise<T> {
        const keysForTier = this.tier === Tier.PRO ? GEMINI_PRO_API_KEYS : GEMINI_FREE_API_KEYS;
        const maxKeyAttempts = Math.max(keysForTier.length, 1);
        const modelsToTry = this.getModelCascade(this.tier, params.mode);
        if (modelsToTry.length === 0) {
            throw new Error(`[LLM Gateway] No Gemini models configured for tier '${this.tier}' and mode '${params.mode}'.`);
        }
        let lastError: ClassifiedError | null = null;

        const promptHash = this.hash(params.system + params.prompt);

        // Fast cache lookup before model loop
        if (!params.skipCache && cascadeIndex === 0) {
            const cacheHit = await this.getFromCache(promptHash);
            if (cacheHit !== null && cacheHit !== undefined) {
                this.lastUsedModel = cacheHit.model || 'cached';
                console.log(`[LLM Cache] Hit for Gemini model: ${this.lastUsedModel}`);
                if (params.json) {
                    return (typeof cacheHit.response === 'string'
                        ? extractAndParseJson<T>(cacheHit.response, params.schema)
                        : cacheHit.response) as T;
                }
                return cacheHit.response as T;
            }
        }

        for (let mIdx = cascadeIndex; mIdx < modelsToTry.length; mIdx++) {
            const model = modelsToTry[mIdx];
            console.log(`[LLM Gateway] [${this.tier}] Mode: ${params.mode} -> Trying Gemini Model: ${model}`);

            for (let keyAttempt = 0; keyAttempt < maxKeyAttempts; keyAttempt++) {
                const apiKey = this.getNextGeminiKey(this.tier);
                if (!apiKey) {
                    lastError = {
                        code: "AUTH_FAILED",
                        statusCode: 401,
                        retryable: false,
                        provider: "gemini",
                        rawMessage: `No Gemini API keys configured for ${this.tier} tier`,
                        userMessage: getUserSafeMessage("AUTH_FAILED")
                    };
                    break;
                }

                const ai = new GoogleGenAI({ apiKey });

                const apiResult = await safeApiCall<T>(async () => {
                    const response = await ai.models.generateContent({
                        model: model,
                        contents: `${params.system}\n\n---\n\n${params.prompt}`,
                        config: {
                            maxOutputTokens: this.getTokenLimit(params.mode),
                            temperature: this.getTemperature(params.mode),
                            responseMimeType: params.json ? 'application/json' : 'text/plain',
                        }
                    });

                    const content = response.text;
                    if (!content || !content.trim()) {
                        throw new Error('No content in Gemini response');
                    }

                    return content as unknown as T;
                }, {
                    provider: 'gemini',
                    schema: params.schema,
                    maxRetries: 1,
                    timeoutMs: this.getTimeout(params.mode)
                });

                if (apiResult.ok) {
                    this.lastUsedModel = model;
                    console.log(`[Gemini] [${this.tier}] Success — model: ${model}`);
                    if (!params.skipCache) {
                        await this.saveToCache(promptHash, apiResult.data, `gemini:${model}`);
                    }
                    return apiResult.data;
                }

                lastError = apiResult.error;

                if (apiResult.error.code === "RATE_LIMITED") {
                    markKeyCooldown(apiKey, 60_000);
                    console.warn(`[Gemini] Key rate limited, cooling down for 60s, rotating to next key...`);
                    continue;
                }

                if (apiResult.error.code === "AUTH_FAILED") {
                    markKeyCooldown(apiKey, 24 * 60 * 60 * 1000);
                    console.warn(`[Gemini] Key auth failed, quarantining key for 24h...`);
                    continue;
                }

                if (apiResult.error.code === "OVERLOADED" || apiResult.error.code === "NOT_FOUND" || apiResult.error.code === "MODEL_GONE") {
                    console.warn(`[Gemini] Model ${model} returned ${apiResult.error.code}, cascading to next model...`);
                    break;
                }

                break;
            }
        }

        const userMsg = getUserSafeMessage("ALL_EXHAUSTED");
        const cascadeError = new Error(userMsg);
        (cascadeError as any).code = "ALL_EXHAUSTED";
        (cascadeError as any).userMessage = userMsg;
        if (params.sessionId) {
            await this.updateSession(params.sessionId, { status: 'FAILED', error: userMsg });
        }
        throw cascadeError;
    }

    private async generateGeminiBuild<T>(params: PrepareParams<T>, cascadeIndex = 0): Promise<T | AsyncGenerator<string, void, unknown>> {
        if (!params.stream) {
            return this.generateWithGemini<T>(params, cascadeIndex);
        }

        const keysForTier = this.tier === Tier.PRO ? GEMINI_PRO_API_KEYS : GEMINI_FREE_API_KEYS;
        const maxKeyAttempts = Math.max(keysForTier.length, 1);
        const modelsToTry = this.getModelCascade(this.tier, params.mode);
        if (modelsToTry.length === 0) {
            throw new Error(`[LLM Gateway] No Gemini models configured for tier '${this.tier}' and mode '${params.mode}'.`);
        }
        let lastError: ClassifiedError | null = null;

        const promptHash = this.hash(params.system + params.prompt);

        // Fast cache lookup before model loop
        if (!params.skipCache && cascadeIndex === 0) {
            const cacheHit = await this.getFromCache(promptHash);
            if (cacheHit !== null && cacheHit !== undefined) {
                this.lastUsedModel = cacheHit.model || 'cached';
                console.log(`[LLM Cache] Hit for Gemini Build model: ${this.lastUsedModel}`);
                if (params.sessionId) {
                    await this.updateSession(params.sessionId, { status: 'REVIEW', code: { code: cacheHit.response, model: this.lastUsedModel } });
                }
                return (async function* () {
                    yield typeof cacheHit.response === 'string' ? cacheHit.response : JSON.stringify(cacheHit.response);
                })() as AsyncGenerator<string, void, unknown>;
            }
        }

        for (let mIdx = cascadeIndex; mIdx < modelsToTry.length; mIdx++) {
            const model = modelsToTry[mIdx];

            for (let keyAttempt = 0; keyAttempt < maxKeyAttempts; keyAttempt++) {
                const apiKey = this.getNextGeminiKey(this.tier);
                if (!apiKey) {
                    lastError = {
                        code: "AUTH_FAILED",
                        statusCode: 401,
                        retryable: false,
                        provider: "gemini",
                        rawMessage: `No Gemini API keys available for ${this.tier} tier`,
                        userMessage: getUserSafeMessage("AUTH_FAILED")
                    };
                    break;
                }

                const ai = new GoogleGenAI({ apiKey });
                console.log(`[Gemini BUILD] [${this.tier}] Streaming with model: ${model}`);

                const apiResult = await safeApiCall(async () => {
                    return await ai.models.generateContentStream({
                        model,
                        contents: `${params.system}\n\n---\n\n${params.prompt}`,
                        config: {
                            maxOutputTokens: this.getTokenLimit(params.mode),
                            temperature: this.getTemperature(params.mode),
                            tools: [{ codeExecution: {} }],
                        }
                    });
                }, { provider: 'gemini', maxRetries: 1, timeoutMs: this.getTimeout(params.mode) });

                if (!apiResult.ok) {
                    lastError = apiResult.error;
                    if (apiResult.error.code === "RATE_LIMITED") {
                        markKeyCooldown(apiKey, 60_000);
                        console.warn(`[Gemini BUILD] Key rate limited, cooling down for 60s, rotating to next key...`);
                        continue;
                    }
                    if (apiResult.error.code === "AUTH_FAILED") {
                        markKeyCooldown(apiKey, 24 * 60 * 60 * 1000);
                        console.warn(`[Gemini BUILD] Key auth failed, quarantining key for 24h...`);
                        continue;
                    }
                    console.warn(`[Gemini BUILD] Stream setup failed for model ${model}: [${apiResult.error.code}] ${apiResult.error.rawMessage}`);
                    break;
                }

                const response = apiResult.data as any;
                const self = this;
                return (async function* () {
                    let fullRes = '';
                    try {
                        for await (const chunk of response) {
                            const text = chunk.text || '';
                            fullRes += text;
                            yield text;
                        }

                        console.log(`[Gemini BUILD] [${self.tier}] Complete — model: ${model}, length: ${fullRes.length}`);

                        if (!params.skipCache && fullRes.trim()) {
                            await self.saveToCache(promptHash, fullRes, `gemini:${model}`);
                        }

                        if (params.sessionId) {
                            self.lastUsedModel = model;
                            await self.updateSession(params.sessionId, {
                                status: 'REVIEW',
                                code: { code: fullRes, model }
                            });
                        }
                    } catch (err: any) {
                        const classified = classifyError(err, "gemini");
                        console.error(`[Gemini BUILD] Stream chunk error (model: ${model}):`, classified.rawMessage);
                        if (params.sessionId) {
                            await self.updateSession(params.sessionId, {
                                status: 'FAILED',
                                error: classified.userMessage
                            });
                        }
                        throw err;
                    }
                })();
            }
        }

        const userMsg = getUserSafeMessage("ALL_EXHAUSTED");
        const cascadeError = new Error(userMsg);
        (cascadeError as any).code = "ALL_EXHAUSTED";
        (cascadeError as any).userMessage = userMsg;
        if (params.sessionId) {
            await this.updateSession(params.sessionId, { status: 'FAILED', error: userMsg });
        }
        throw cascadeError;
    }

    // ═══════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════
    async generate<T>(params: PrepareParams<T>): Promise<T | AsyncGenerator<string, void, unknown>> {
        if (this.tier === Tier.PRO) {
            try {
                if (params.mode === 'CODE') {
                    return await this.generateGeminiBuild<T>(params);
                }
                return await this.generateWithGemini<T>(params);
            } catch (proErr) {
                console.warn('[LLM Gateway] Pro tier Gemini failed all attempts. Emergency fallback to NVIDIA NIM...', proErr);
                try {
                    // Do not pollute PRO cache with emergency downgraded responses
                    return await this.generateWithNvidia<T>({ ...params, skipCache: true });
                } catch (fallbackErr) {
                    console.error('[LLM Gateway] Both Gemini and NVIDIA fallback failed for Pro tier:', fallbackErr);
                    throw fallbackErr;
                }
            }
        } else {
            // Free Tier: Primary is Gemini Flash Lite / Flash cascade with multi-key rotation
            try {
                if (params.mode === 'CODE') {
                    return await this.generateGeminiBuild<T>(params);
                }
                return await this.generateWithGemini<T>(params);
            } catch (freeErr) {
                console.warn('[LLM Gateway] Free tier Gemini exhausted all keys/models. Emergency fallback to NVIDIA NIM...', freeErr);
                try {
                    return await this.generateWithNvidia<T>({ ...params, skipCache: true });
                } catch (fallbackErr) {
                    console.error('[LLM Gateway] Both Gemini and NVIDIA fallback failed for Free tier:', fallbackErr);
                    throw fallbackErr;
                }
            }
        }
    }
}
