import baseConfig from "../tailwind.config";
import type { Config } from "tailwindcss";

const config: Config = {
  ...baseConfig,
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
    "../src/**/*.{ts,tsx}",
  ],
};

export default config;
