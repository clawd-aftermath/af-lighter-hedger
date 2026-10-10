import type { RealAfVenue, RealLighterVenue } from "../engine/adapters";
import type { AfVenue, LighterVenue } from "../engine/types";
import type { StateStore } from "../state/store";
import type { PaperVenues } from "./venues";

// Dry mode trades a shadow ledger. AF builds are simulated and Lighter signing
// uses a read nonce; neither real adapter's submission path is reachable.
export function dryVenues(
  paper: PaperVenues,
  af: RealAfVenue,
  lighter: RealLighterVenue,
  store: StateStore,
  nonce: () => Promise<bigint>,
): { af: AfVenue; lighter: LighterVenue } {
  return {
    af: {
      ...paper.af,
      funding: () => af.funding(),
      quote: async (request, context) => {
        const simulation = await af.quote(request, context);
        store.set(`dry:af_simulation:${context.intent.id}`, simulation);
        if (simulation.status !== "success") return simulation;
        await paper.af.quote(request, context);
        return { ...simulation, simulated: true };
      },
      cancel: async (symbol, orders, context) => {
        const simulation = await af.cancel(symbol, orders, context);
        if (simulation.status !== "success") return simulation;
        await paper.af.cancel(symbol, orders, context);
        return { ...simulation, simulated: true };
      },
      flatten: async (symbol, side, size, slippage, context) => {
        const simulation = await af.flatten(
          symbol,
          side,
          size,
          slippage,
          context,
        );
        if (simulation.status !== "success") return simulation;
        await paper.af.flatten(symbol, side, size, slippage, context);
        return { ...simulation, simulated: true };
      },
    },
    lighter: {
      ...paper.lighter,
      funding: () => lighter.funding(),
      hedge: async (request, context) => {
        const signed = lighter.signOffline(request, await nonce());
        // Signed transaction material is kept local, never emitted in logs.
        store.set(`dry:lighter_signed:${context.intent.id}`, signed);
        return paper.lighter.hedge(request, context);
      },
    },
  };
}
