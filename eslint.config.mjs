import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "coverage/**", "reports/**", "artifacts/**"] },
  js.configs.recommended,
  {
    files: ["t3-mission/test/**/*.mjs"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='emit'][arguments.0.value='request']",
          message:
            "Use createHandlerHud from hud-handler-fixture.mjs and a real loopback HTTP request; partial request/response objects bypass security and lifecycle contracts.",
        },
        {
          selector:
            "CallExpression[callee.property.name='mkdtempSync'][arguments.0.type='Literal']",
          message:
            "Build temporary fixture paths with path.join(os.tmpdir(), prefix); hardcoded macOS paths fail on Linux and bypass per-suite isolation.",
        },
      ],
    },
  },
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "no-unused-vars": [
        "error",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          caughtErrors: "none",
          ignoreRestSiblings: true,
          varsIgnorePattern: "^_",
        },
      ],
      "no-constant-binary-expression": "error",
      "no-promise-executor-return": "error",
      "no-unreachable-loop": "error",
      eqeqeq: ["error", "smart"],
    },
  },
];
