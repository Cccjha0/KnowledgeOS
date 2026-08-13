import js from "@eslint/js";

export default [
  {
    files: ["plugins/knowledgeos-obsidian/**/*.js"],
    ignores: ["plugins/knowledgeos-obsidian/dist/**"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        clearInterval: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        module: "readonly",
        navigator: "readonly",
        process: "readonly",
        require: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        window: "readonly",
        __dirname: "readonly",
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": "off",
    },
  },
];
