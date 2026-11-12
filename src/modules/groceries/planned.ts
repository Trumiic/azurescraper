import type { ScraperModule } from "../../core/types.js";

/** Placeholder modules: they show on the Groceries page until each one is built. */
function planned(id: string, name: string, method: string): ScraperModule {
  return { id, name, description: `${name} grocery products`, method, status: () => "planned" };
}

export const walmart = planned("walmart", "Walmart", "Embedded JSON in page HTML (likely __NEXT_DATA__)");
export const meijer = planned("meijer", "Meijer", "To be investigated");
export const target = planned("target", "Target", "To be investigated (internal JSON API)");
export const aldi = planned("aldi", "Aldi", "To be investigated");
