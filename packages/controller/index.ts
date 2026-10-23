import { Database, sessions } from "../model/db/client";
import { eq } from "drizzle-orm";
import { LLM, Tier, SimpleKv } from "../model/llm";
import { classifyError } from "../model/llm/safeApiCall";
import { ClarifierAgent } from "../agents/clarifer";
import { PlannerAgent } from "../agents/planner";
import { CoderAgent } from "../agents/coder";
import { ClarificationResponse, BuildResponse, PlanResponse } from "../model/types";

interface ControllerOutput {
    type: 'CLARIFYING' | 'PLANNING' | 'CODING' | 'COMPLETED' | 'ERROR' | 'INIT' | 'STREAM_REQUIRED';
    data: ClarificationResponse | PlanResponse | BuildResponse | string;
}

export class Controller {
    private llm!: LLM;
    private sessionId: string;
    private db: Database;
    private kv?: SimpleKv

    constructor(sessionId: string, db: Database, kv?: SimpleKv) {
        this.sessionId = sessionId;
        this.db = db;
        this.kv = kv
    }

    async start(userMessage?: string, retryDepth: number = 0): Promise<ControllerOutput> {
        try {
            const session = await this.db.query.sessions.findFirst({
                where: eq(sessions.id, this.sessionId),
                with: {
                    user: true
                }
            });

            if (!session) throw new Error("Session not found");

            this.llm = new LLM(session.user.tier as unknown as Tier, this.kv, this.db);

            const clarifierAgent = new ClarifierAgent(this.llm, session.id);
            const plannerAgent = new PlannerAgent(this.llm, session.id);

            let currentStatus = session.status;
            const clarificationData = session.clarification as unknown as ClarificationResponse;

            if (currentStatus === 'CLARIFYING' && clarificationData && clarificationData.isSufficient) {
                currentStatus = 'PLANNING';
                await this.db.update(sessions).set({
                    status: 'PLANNING'
                }).where(eq(sessions.id, this.sessionId)).catch(() => { });
            }

            switch (currentStatus) {
                case 'INIT':
                    const questions = await clarifierAgent.clarify(session.prompt);
                    return {
                        type: 'INIT',
                        data: questions
                    }
                case 'CLARIFYING':
                    const prompt = userMessage ? userMessage : session.prompt;
                    const clarification = await clarifierAgent.clarify(prompt, session.clarification as unknown as ClarificationResponse)

                    return {
                        type: 'CLARIFYING',
                        data: clarification as unknown as ClarificationResponse
                    }
                case 'PLANNING':
                    const planReq = session.clarification as unknown as ClarificationResponse
                    const summary = (typeof planReq?.summary === 'string' && planReq.summary.trim().length > 0) ? planReq.summary : session.prompt;
                    const plan = await plannerAgent.plan(summary, session.prompt)

                    return {
                        type: 'PLANNING',
                        data: plan as unknown as PlanResponse
                    }

                case 'BUILDING':
                case 'REBUILD':
                case 'REVIEW':
                    return {
                        type: 'STREAM_REQUIRED',
                        data: "Session requires Streaming - connecting to /api/stream"
                    }

                case 'COMPLETED':
                    return {
                        type: 'COMPLETED',
                        data: session.code as unknown as BuildResponse
                    }
                case 'FAILED': {
                    if (retryDepth > 2) {
                        return {
                            type: 'ERROR',
                            data: "Max recovery attempts reached. Please start a new session."
                        };
                    }

                    let fallbackStatus = 'INIT';
                    if (session.clarification) {
                        const clar = session.clarification as unknown as ClarificationResponse;
                        fallbackStatus = clar.isSufficient ? 'PLANNING' : 'CLARIFYING';
                    } else if (session.prompt) {
                        fallbackStatus = 'INIT';
                    }

                    await this.db.update(sessions).set({
                        status: fallbackStatus as any,
                        error: null
                    }).where(eq(sessions.id, this.sessionId));

                    return this.start(userMessage, retryDepth + 1);
                }

                default:
                    return {
                        type: 'ERROR',
                        data: "Unknown session status"
                    }

            }
        }
        catch (error) {
            console.error('[Controller Error]:', error);
            const classified = classifyError(error);
            await this.db.update(sessions).set({
                status: 'FAILED',
                error: classified.userMessage
            }).where(eq(sessions.id, this.sessionId)).catch(() => { });
            return {
                type: 'ERROR',
                data: classified.userMessage
            };
        }
    }
}
