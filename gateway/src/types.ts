export class ProviderError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type Item = Record<string, unknown>;

export interface Ctx { key?: string; signal: AbortSignal }

export interface Provider {
  id: string;
  /** Env var holding this provider's credential; provider is skipped when it's missing. */
  needs?: string;
  /** Credential that is used when present but not required. */
  optional?: string;
  stream(params: Record<string, any>, ctx: Ctx): AsyncGenerator<Item>;
  /** Cheap call used by the worker to check a cooling provider. */
  probe?: Record<string, unknown>;
}

export interface ParamSpec { type: 'string' | 'integer' | 'number' | 'boolean'; required?: boolean; default?: unknown; description?: string }

export interface Tool {
  category: 'Search' | 'Scrape' | 'Social' | 'Crypto' | 'Finance' | 'E-commerce' | 'Business';
  description: string;
  params: Record<string, ParamSpec>;
  credits: number;
  /** Normalized shape every provider returns, documented in /v1/tools. */
  output: string;
  /** Key used to skip items already sent when a stream resumes on another provider. */
  dedupe(item: Item): string;
  /** Markdown rendering of one item. */
  markdown(item: Item): string;
  providers: Provider[];
}
