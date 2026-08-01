"use client";

import { useState } from "react";
import { Button } from "./button";

/**
 * Copies a value that is shown exactly once.
 *
 * The API-key plaintext is never stored — the server keeps only its SHA-256 — so a key lost to a
 * mis-selection can only be revoked and reissued. Asking an operator to select a 43-character
 * base64 string by hand, once, is where that goes wrong.
 *
 * The confirmation is the BUTTON'S OWN LABEL rather than a toast: the effect is invisible (a
 * clipboard has no UI), so it needs saying, and saying it where the click happened is quieter than
 * a notification. `aria-live="polite"` on the label, because the change is the whole message.
 *
 * `navigator.clipboard` is UNDEFINED on an insecure origin, not merely failing — so reaching for
 * `.writeText` throws synchronously, before there is a promise to attach a `.catch` to. Left that
 * way the button swallows the error and stays idle, which is the exact failure this component
 * exists to prevent: "I clicked copy" is the belief that loses a key shown once. The guard runs
 * first and says so.
 */
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  return (
    <Button
      type="button"
      variant="quiet"
      state={state === "failed" ? "error" : undefined}
      onClick={() => {
        if (!navigator.clipboard) {
          setState("failed");
          return;
        }
        navigator.clipboard
          .writeText(value)
          .then(() => {
            setState("copied");
          })
          .catch(() => {
            setState("failed");
          });
      }}
    >
      <span aria-live="polite">
        {state === "copied"
          ? "Copied"
          : state === "failed"
            ? "Copy failed — select it by hand"
            : label}
      </span>
    </Button>
  );
}
