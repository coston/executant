import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "./theme.js";

interface Props {
  onSubmit: (message: string) => void;
  onCancel: () => void;
}

export function InterjectInput({ onSubmit, onCancel }: Props) {
  const [value, setValue] = useState("");

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      if (value.trim()) onSubmit(value.trim());
      else onCancel();
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setValue((v) => v + input);
    }
  });

  return (
    <Box marginTop={1} flexDirection="row">
      <Text color={theme.primary} bold>
        {"▷ "}
      </Text>
      <Text>{value}</Text>
      <Text color={theme.primary}>{"▌"}</Text>
      <Text dimColor>{"  esc to cancel"}</Text>
    </Box>
  );
}
