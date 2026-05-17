import { CheckpointStore } from './checkpointStore';
import type { Checkpoint } from './types';

export async function getCheckpoint(id: string, cwd: string): Promise<Checkpoint | null> {
  const store = new CheckpointStore(cwd);
  return store.getCheckpoint(id);
}
