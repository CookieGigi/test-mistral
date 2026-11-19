import { defineConfig } from "vite";

export default defineConfig({
  base: "/test-mistral/",
  build: {
    target: "es2022",
  },
});
