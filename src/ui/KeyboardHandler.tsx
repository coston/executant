import { useInput } from 'ink';

export function KeyboardHandler({ onExit }: { onExit: () => void }) {
  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) onExit();
  });
  return null;
}
