/**
 * ScrapeContext wires together the shared dependencies a pipeline run needs:
 * logger, HTTP client, browser pool, and the resolved card index.
 *
 * TODO: implement.
 */
export interface ScrapeContext {
  readonly logger: unknown;
  readonly http: unknown;
  readonly browserPool: unknown;
  readonly cardIndex: unknown;
}
