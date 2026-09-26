export interface Config {
  mode: string;
  retries: number;
}

export const defaults: Config = { mode: "auto", retries: 2 };
