// Helpers for the native engine processes (whisper-server, llama-server).
import { ChildProcess } from 'node:child_process';
import * as os from 'node:os';

/**
 * Runs an engine below normal priority. Dictation is background work: when
 * the PC is busy (a game, an editor, a build) Windows should serve the app
 * the user is working in first instead of letting the engines freeze it.
 * GPU scheduling on Windows also follows the process priority.
 */
export function runInBackground(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    /* the process already exited, or priority can't be changed */
  }
}
