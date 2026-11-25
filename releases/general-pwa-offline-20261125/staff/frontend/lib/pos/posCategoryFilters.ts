import type { MenuItem } from '../../types';
import { classifyPosMenuItemWithCategories, NEEDS_CLASSIFICATION_CATEGORY, type PosMenuCategoryDefinition, type PosMenuClassification } from '../posMenuNavigation';

export function classifyMenuItems(availableMenuItems: MenuItem[], posMenuCategories: PosMenuCategoryDefinition[]) {
    return new Map(
    availableMenuItems.map(item => [
      item.id,
      classifyPosMenuItemWithCategories(
        item as MenuItem & Record<string, unknown>,
        posMenuCategories,
      ),
    ]),
  );
}

export function countMenuCategories(availableMenuItems: MenuItem[], classificationByItemId: Map<string, PosMenuClassification>) {
    const counts = new Map<string, number>();
    availableMenuItems.forEach(item => {
      const categoryCode = classificationByItemId.get(item.id)?.category.code || NEEDS_CLASSIFICATION_CATEGORY.code;
      counts.set(categoryCode, (counts.get(categoryCode) || 0) + 1);
    });
    return counts;
}

export function rankFastMenuItems(availableMenuItems: MenuItem[]) {
    return [...availableMenuItems]
      .sort((a: any, b: any) => {
        const aPopular = Boolean(a.isPopular || a.isFastItem || a.fastItem);
        const bPopular = Boolean(b.isPopular || b.isFastItem || b.fastItem);
        if (aPopular !== bPopular) return aPopular ? -1 : 1;

        const aSales = Number(a.salesCount || a.orderCount || a.popularityScore || 0);
        const bSales = Number(b.salesCount || b.orderCount || b.popularityScore || 0);
        if (aSales !== bSales) return bSales - aSales;

        const orderA = typeof a.sortOrder === 'number' ? a.sortOrder : 999;
        const orderB = typeof b.sortOrder === 'number' ? b.sortOrder : 999;
        if (orderA !== orderB) return orderA - orderB;
        return (a.name || '').localeCompare(b.name || '');
      })
      .slice(0, 8);
}

export function filterMenuCategory(availableMenuItems: MenuItem[], classificationByItemId: Map<string, PosMenuClassification>, selectedCategoryId: string, selectedSubcategoryId: string, topFeaturedItems: MenuItem[]) {    if (selectedCategoryId === 'QUICK_PICKS') return topFeaturedItems;
    if (selectedCategoryId === 'ALL') return availableMenuItems;

    return availableMenuItems.filter(item => {
      const classification = classificationByItemId.get(item.id);
      if (classification?.category.code !== selectedCategoryId) return false;
      return selectedSubcategoryId === 'ALL'
        || classification.subcategory?.code === selectedSubcategoryId;
    });
}

export function groupMenuSections(filteredMenuItems: MenuItem[], classificationByItemId: Map<string, PosMenuClassification>, searchQuery: string, selectedCategoryId: string, selectedSubcategoryId: string, selectedCategory: PosMenuCategoryDefinition | undefined) {
    if (
      searchQuery.trim()
      || selectedCategoryId === 'ALL'
      || selectedCategoryId === 'QUICK_PICKS'
      || !selectedCategory
      || selectedCategory.subcategories.length === 0
      || selectedSubcategoryId !== 'ALL'
    ) {
      return [{ id: 'ALL', label: null, items: filteredMenuItems }];
    }

    return selectedCategory.subcategories
      .map(subcategory => ({
        id: subcategory.code,
        label: subcategory.name,
        items: filteredMenuItems.filter(item => (
          classificationByItemId.get(item.id)?.subcategory?.code === subcategory.code
        )),
      }))
      .filter(section => section.items.length > 0);
}

export function menuTileTone(categoryCode: string): { badge: string; icon: string } {
  switch (categoryCode) {
    case 'ESPRESSO_BAR':
      return {
        badge: 'bg-[#3e2723] text-white',
        icon: 'text-[#5c4033]',
      };
    case 'ICED_COFFEES':
    case 'COLD_BREW_VIETNAMESE_STYLE':
    case 'COLD_CRAFTED':
      return {
        badge: 'bg-[#e6f1f6] text-[#24526a]',
        icon: 'text-[#24526a]',
      };
    case 'MATCHA_MANUAL_BREWS':
    case 'SMOOTHIES':
    case 'FRESH_JUICES':
    case 'HERBAL_TEA':
      return {
        badge: 'bg-[#edf6ec] text-[#3f6a4a]',
        icon: 'text-[#3f6a4a]',
      };
    case 'ONLY_AT_BOND':
    case 'JAFFLE_BITES_SALADS':
    case 'PIZZA_PIDE':
    case 'BAKED_BAKERY_ICE_CREAM':
      return {
        badge: 'bg-[#f8ece8] text-[#8a4f3b]',
        icon: 'text-[#8a4f3b]',
      };
    default:
      return {
        badge: 'bg-[#f3efe9] text-[#6d584a]',
        icon: 'text-[#6d584a]',
      };
  }
}
