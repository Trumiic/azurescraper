import type { Category } from "./types.js";
import { kroger } from "../modules/groceries/kroger/index.js";
import { walmart, meijer, target, aldi } from "../modules/groceries/planned.js";

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
    modules: [kroger, walmart, meijer, target, aldi],
  },
];

export function findCategory(id: string) {
  return categories.find((c) => c.id === id);
}

export function findModule(categoryId: string, moduleId: string) {
  return findCategory(categoryId)?.modules.find((m) => m.id === moduleId);
}
