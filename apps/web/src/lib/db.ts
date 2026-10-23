import { getCloudflareContext } from "@opennextjs/cloudflare"
import { createDb } from "@packages/model/db/client"

export async function getDb() {
    const { env } = await getCloudflareContext({ async: true });
    return createDb((env as unknown as Env).DB);;
}
export async function getEnv() {
    const { env } = await getCloudflareContext({ async: true });
    return env as unknown as Env;
}