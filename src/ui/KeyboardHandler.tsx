import { useInput } from "ink";

interface Props {
  onExit: () => void;
  onInterject?: () => void;
  isInterjecting?: boolean;
}

export function KeyboardHandler({
  onExit,
  onInterject,
  isInterjecting,
}: Props) {
  useInput((input, key) => {
    if (isInterjecting) return; // InterjectInput owns input while open
    if (input === "q" || (key.ctrl && input === "c")) onExit();
    if (input === "i" && onInterject) onInterject();
  });
  return null;
}
