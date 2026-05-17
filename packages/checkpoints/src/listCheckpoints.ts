import { CheckpointStore } from './checkpointStore';
import type { Checkpoint } from './types';

export async function listCheckpoints(cwd: string): Promise<Checkpoint[]> {
  const store = new CheckpointStore(cwd);
  return store.loadIndex();
}
