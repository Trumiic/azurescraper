import type { Category } from "./types.js";
import { kroger } from "../modules/groceries/kroger/index.js";
import { walmart, target, aldi } from "../modules/groceries/planned.js";
import { meijer } from "../modules/groceries/meijer/index.js";
import { meijerWeb } from "../modules/groceries/meijer/web.js";
import { nutrition } from "../modules/groceries/nutrition/index.js";
import { krogerWeb } from "../modules/groceries/kroger/web.js";
import { registerExtension } from "../scraper/engine.js";

// Website scraper extensions (see src/scraper)
registerExtension(krogerWeb);
registerExtension(meijerWeb);

/**
 * Every category tile on the home page, and the modules inside it.
 * To add a new category: add an entry here. To add a store: add a module.
 */
export const categories: Category[] = [
  {
    id: "groceries",
    name: "Groceries",
    description: "Prices and product data from grocery stores",
    icon: "🛒",
    modules: [kroger, walmart, meijer, target, aldi, nutrition],
  },
  {
    id: "video-games",
    name: "Video Games",
    description: "Placeholder: game data scrapers will live here",
    icon: "🎮",
    modules: [],
  },
];

export function findCategory(id: string) {
  return categories.find((c) => c.id === id);
}

export function findModule(categoryId: string, moduleId: string) {
  return findCategory(categoryId)?.modules.find((m) => m.id === moduleId);
}
