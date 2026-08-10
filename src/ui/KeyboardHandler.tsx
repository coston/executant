import { useInput } from "ink";

interface Props {
  onExit: () => void;
  onInterject?: () => void;
  /** True while another component owns keyboard input (interject, retrospective). */
  disabled?: boolean;
}

export function KeyboardHandler({ onExit, onInterject, disabled }: Props) {
  useInput((input, key) => {
    if (disabled) return; // another overlay owns input while open
    if (input === "q" || (key.ctrl && input === "c")) onExit();
    if (input === "i" && onInterject) onInterject();
  });
  return null;
}
