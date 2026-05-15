/**
 * ScrapeContext wires together the shared dependencies a pipeline
 * run needs: logger, HTTP client, and the resolved card index.
 *
 * Reserved for future use. The current adapters reach for their own
 * undici fetch and don't consume this struct.
 */
export interface ScrapeContext {
  readonly logger: unknown;
  readonly http: unknown;
  readonly cardIndex: unknown;
}
