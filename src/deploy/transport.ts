/**
 * How `contrail deploy --target railway` (or whatever self-hosted target comes next) actually
 * moves a built site onto the team's own infrastructure. The build logic, path layout, and guards
 * in `src/deploy.ts` are transport-independent — they only ever call `push`, never anything
 * Railway-specific. This exists because the team's own hosting is still an open question (the
 * Plane fork has docker-compose and `deployments/{cli,kubernetes,swarm}`, not Railway) — Railway is
 * today's implementation (`src/deploy/railway.ts`), not a permanent assumption.
 */
export interface DeployTransport {
  /** Identifies the transport in logs and error messages, e.g. `'railway'`. */
  name: string
  /**
   * Uploads everything under `localDir` to `remotePath` on the target. With `opts.dryRun`, the
   * transport must report what it would do (destination, file count, its own exact command) and
   * upload nothing — `filesSent` still reflects what a real push would send.
   */
  push(localDir: string, remotePath: string, opts: { dryRun?: boolean }): Promise<{ filesSent: number; bytes?: number }>
}
