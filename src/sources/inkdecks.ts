import type { SourceAdapter, TournamentRef, RawTournament } from "./types.js";
import type { ScrapeContext } from "../context.js";

export const inkdecks: SourceAdapter = {
  sourceName: "inkdecks.com",

  async listTournaments(_ctx: ScrapeContext): Promise<TournamentRef[]> {
    // TODO: HTTP-first sniff for JSON endpoints, fall back to Playwright.
    throw new Error("inkdecks.listTournaments: not yet implemented");
  },

  async fetchTournament(_ref, _ctx): Promise<RawTournament> {
    // TODO: parse a single tournament page.
    throw new Error("inkdecks.fetchTournament: not yet implemented");
  },
};
