import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/node_modules/**",
      // Agent worktrees hold transient checkouts whose generated `next-env.d.ts` fails this
      // config for code that is not in anyone's diff.
      ".claude/**",
      "**/coverage/**",
      // Agent scratch: `.claude/worktrees/*` holds transient checkouts of this same repository,
      // so without this every file is linted twice and a worktree's generated `next-env.d.ts`
      // fails the gate for code that is not in the diff.
      ".claude/**",
      "**/*.config.js",
      "**/*.config.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
);
