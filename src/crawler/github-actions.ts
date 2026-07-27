import type { InstarPost } from "./types/instar";
import type { InstarStarSyncPayload } from "./types/yt-dlp";
import { BaseWorker } from "./worker";

class GithubActionWorker extends BaseWorker {
    override onStarStart?(starName: string): Promise<void> {
        throw new Error("Method not implemented.");
    }
    override onPostStart?(postId: string): Promise<void> {
        throw new Error("Method not implemented.");
    }
    override onPostEnd?(postId: string): Promise<void> {
        throw new Error("Method not implemented.");
    }
    override onStarEnd?(starName: string): Promise<void> {
        throw new Error("Method not implemented.");
    }
    override claimTasks(): Promise<string[]> {
        throw new Error("Method not implemented.");
    }
    override isExists(postId: string): Promise<boolean> {
        throw new Error("Method not implemented.");
    }
    override syncStarProfile(payload: InstarStarSyncPayload): Promise<void> {
        throw new Error("Method not implemented.");
    }
    override syncPostDetail(payload: InstarPost): Promise<void> {
        throw new Error("Method not implemented.");
    }

}