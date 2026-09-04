#!/usr/bin/env node

/**
 * Owner-approved Phase 1 data definition for The Tasting Room.
 *
 * This module is deliberately persistence-free. It is safe to import in tests or
 * print as JSON, and performs no Firebase reads or writes. The preview preparation
 * script is the only place allowed to turn this definition into isolated preview
 * documents. Every sellable record remains unavailable until an owner-approved BOM
 * replaces the empty placeholder.
 */

export const TASTING_ROOM_STORE_ID = 'TASTING_ROOM_29';
export const TASTING_ROOM_INVENTORY_STORE_ID = 'NOIDA_29';

const customerPresentation = {
  conceptName: 'THE TASTING ROOM',
  locationLabel: 'Coffee Bond · Noida Sector 29',
  tagline: 'For the love of discovering.',
  orderContextLabel: 'Place order',
  orderActionLabel: 'Place order',
  searchPlaceholder: 'Search The Tasting Room menu',
  searchPromptTitle: 'Discover The Tasting Room',
  searchPromptDescription: 'Explore dishes, flights and experiences.',
  featuredLabel: 'Tasting Room favourites',
  fullMenuLabel: 'The full tasting menu',
  selectorEyebrow: 'Destination experience',
  selectorDescription: 'Flights · Small plates · Experiences',
};

const sharedStore = {
  id: TASTING_ROOM_STORE_ID,
  code: TASTING_ROOM_STORE_ID,
  storeCode: TASTING_ROOM_STORE_ID,
  name: 'The Tasting Room by Coffee Bond',
  displayName: 'The Tasting Room by Coffee Bond',
  address: 'Noida Sector 29',
  city: 'Noida',
  state: 'Uttar Pradesh',
  physicalParentStoreId: TASTING_ROOM_INVENTORY_STORE_ID,
  inventoryStoreId: TASTING_ROOM_INVENTORY_STORE_ID,
  legalAndGstSourceStoreId: TASTING_ROOM_INVENTORY_STORE_ID,
  excludeFromNearestSelection: true,
  customerPresentation,
  inventoryMode: 'FINISHED_GOODS',
  inventoryPolicy: 'STRICT',
  timezone: 'Asia/Kolkata',
};

/** Never write this document in this task; it records the production launch guard. */
export const tastingRoomProductionGuardStore = {
  ...sharedStore,
  status: 'DRAFT',
  isActive: false,
  posEnabled: false,
  onlineOrderingEnabled: false,
  customerOrderingEnabled: false,
  publicOrderingEnabled: false,
  acceptingOrders: false,
  isAcceptingOrders: false,
  previewOnly: false,
};

/** May exist only inside the isolated coffee-bond-pos-preview project. */
export const tastingRoomPreviewStore = {
  ...sharedStore,
  status: 'ACTIVE',
  isActive: true,
  posEnabled: true,
  onlineOrderingEnabled: true,
  customerOrderingEnabled: true,
  publicOrderingEnabled: true,
  acceptingOrders: true,
  isAcceptingOrders: true,
  previewOnly: true,
};

export const tastingRoomCategories = [
  ['TR_SPREAD_SHARE', 'TO SPREAD & SHARE'],
  ['TR_CROSTINI_GARDEN', 'CROSTINI GARDEN'],
  ['TR_FRESH_CRISP', 'FRESH & CRISP'],
  ['TR_SAY_CHEESE', 'SAY CHEESE'],
  ['TR_SMALL_PIZZAS', 'SMALL PIZZAS'],
  ['TR_SWEET_FINISH', 'A SWEET FINISH'],
  ['TR_FLIGHTS', 'FLIGHTS & EXPERIENCES'],
  ['TR_FOR_TWO', 'FOR TWO'],
].map(([code, name], index) => ({
  id: code,
  code,
  name,
  sortOrder: (index + 1) * 10,
  defaultPrepStation: 'KITCHEN',
  isActive: true,
  previewOnly: true,
}));

const menu = [
  ['TR_ESPRESSO_BUN', 'Espresso Bun', 245, 'TO SPREAD & SHARE', 'Whipped salty espresso butter, served for tearing and spreading on high-quality bun.'],
  ['TR_THREE_DIPS', 'The Three Dips', 395, 'TO SPREAD & SHARE', 'House hummus · Green olive tapenade · Whipped ricotta dukkah · warm sourdough.'],
  ['TR_GARLIC_CONFIT_LABNEH', 'Garlic Confit & Labneh', 325, 'TO SPREAD & SHARE', 'Slow-cooked garlic, cultured labneh, chilli, garlic oil, parmesan and toasted sourdough.'],
  ['TR_THREE_CROSTINI', 'Three Crostini', 695, 'CROSTINI GARDEN', 'Tomato, basil & parmesan · Pear, ricotta, pistachio & honey · Olive tapenade, sun-dried tomato & herbs.'],
  ['TR_COTTAGE_CHEESE_PESTO_NUTS', 'Cottage Cheese, Pesto & Nuts', 595, 'CROSTINI GARDEN', 'Cottage cheesecake, roasted nuts and crisp sourdough with house pesto.'],
  ['TR_NUTTY_SALAD', 'The Nutty Salad', 425, 'FRESH & CRISP', 'Crisp leaves, apple, roasted almonds and walnuts, seeds, parmesan and date-mustard dressing.'],
  ['TR_CHARRED_HALLOUMI', 'Charred Halloumi', 525, 'SAY CHEESE', 'Golden halloumi, house falafel, lemon zest, hummus, dukkah and fresh herbs served with sourdough.'],
  ['TR_PASTA_HALLOUMI', 'Pasta Halloumi', 425, 'SAY CHEESE', 'Crisp seasonal vegetables, shaved parmesan, halloumi.'],
  ['TR_3_CHEESE_PASTA', '3 Cheese Pasta', 475, 'SAY CHEESE', 'Spaghetti served with house ricotta, imported parmesan, imported cheddar cheese.'],
  ['TR_PIZZA_BLUE_CHEESE_PEAR_WALNUT', 'Blue Cheese, Pear & Walnut', 575, 'SMALL PIZZAS', 'White base, mozzarella, blue cheese, pear, caramelised onion and date glaze.'],
  ['TR_PIZZA_SHROOM_CHEDDAR_PARMESAN', 'Shroom, Cheddar & Parmesan', 525, 'SMALL PIZZAS', 'Mushroom, mature cheddar, mozzarella, parmesan and caramelised onion.'],
  ['TR_PIZZA_TOMATO_MOZZARELLA', 'Tomato, Mozzarella', 475, 'SMALL PIZZAS', 'Tomato, mozzarella and fresh basil on a small house flour base with fresh rocket.'],
  ['TR_TIRAMISU_FOR_TWO', 'Tiramisu for Two', 495, 'A SWEET FINISH', 'Coffee-soaked layers, mascarpone cream and cacao.'],
  ['TR_BROWNIE_GANACHE_SALTED_CREAM', 'Brownie, Ganache & Salted Cream', 350, 'A SWEET FINISH', 'Fudgy brownie, dark chocolate ganache and salted caramel cream.'],
  ['TR_MINI_AFFOGATO', 'Mini Affogato', 220, 'A SWEET FINISH', 'A small pour of intense espresso over house vanilla ice cream.'],
  ['TR_COFFEE_THREE_WAYS', 'Coffee Three Ways', 495, 'FLIGHTS & EXPERIENCES', 'Mini Espresso · Mini Cortado · Cold Brew / Manual Brew.'],
  ['TR_COLD_BOND_FLIGHT', 'The Cold Bond Flight — Choose Any 3', 595, 'FLIGHTS & EXPERIENCES', 'Mini Cloud Black / Mont Blanc · Mini Miso Latte · Single-Origin Iced Chocolate.'],
  ['TR_ZERO_PROOF_FLIGHT', 'Zero-Proof Flight — Any 3', 545, 'FLIGHTS & EXPERIENCES', 'Mini Maison Lemonade · Lemon OJ Bitter · Coco Mango / Mango Matcha.'],
  ['TR_WAKE_UP_WITH_BOND', 'Wake Up With Bond — 3 Drinks', 595, 'FLIGHTS & EXPERIENCES', 'Mini Tropic Shot · Egg Coffee · Single-Origin Hot Chocolate.'],
  ['TR_SET_A', 'Tasting Room Set A', 2795, 'FOR TWO', 'Espresso Bun · The Three Dips · The Nutty Salad · choice of Charred Halloumi or one small pizza · Brownie, Ganache & Salted Cream · two miniature drinks · maximum 2 guests.'],
  ['TR_SET_B', 'Tasting Room Set B', 3100, 'FOR TWO', 'Espresso Bun · Three Crostini · Cottage Cheese, Pesto & Nuts · choice of one pasta or one small pizza · Tiramisu · two miniature drinks · maximum 2 guests.'],
];

const internalComponents = [
  ['TR_COMPONENT_MINI_AFFOGATO_ESPRESSO', 'Mini Affogato Espresso Pour', 'BARISTA'],
  ['TR_COMPONENT_MINI_AFFOGATO_ICE_CREAM', 'Mini Affogato House Vanilla Ice Cream', 'KITCHEN'],
  ['TR_COMPONENT_MINI_ESPRESSO', 'Mini Espresso', 'BARISTA'],
  ['TR_COMPONENT_MINI_CORTADO', 'Mini Cortado', 'BARISTA'],
  ['TR_COMPONENT_COLD_BREW_MANUAL_BREW', 'Cold Brew / Manual Brew', 'BARISTA'],
  ['TR_COMPONENT_MINI_CLOUD_BLACK_MONT_BLANC', 'Mini Cloud Black / Mont Blanc', 'BARISTA'],
  ['TR_COMPONENT_MINI_MISO_LATTE', 'Mini Miso Latte', 'BARISTA'],
  ['TR_COMPONENT_SINGLE_ORIGIN_ICED_CHOCOLATE', 'Single-Origin Iced Chocolate', 'BARISTA'],
  ['TR_COMPONENT_MINI_MAISON_LEMONADE', 'Mini Maison Lemonade', 'BARISTA'],
  ['TR_COMPONENT_LEMON_OJ_BITTER', 'Lemon OJ Bitter', 'BARISTA'],
  ['TR_COMPONENT_COCO_MANGO_MANGO_MATCHA', 'Coco Mango / Mango Matcha', 'BARISTA'],
  ['TR_COMPONENT_MINI_TROPIC_SHOT', 'Mini Tropic Shot', 'BARISTA'],
  ['TR_COMPONENT_EGG_COFFEE', 'Egg Coffee', 'BARISTA'],
  ['TR_COMPONENT_SINGLE_ORIGIN_HOT_CHOCOLATE', 'Single-Origin Hot Chocolate', 'BARISTA'],
];

const ref = (code, quantity = 1) => ({ finishedGoodId: code, finishedGoodCode: code, quantity });

const groupDefinitions = [
  {
    id: 'TR_COLD_BOND_DISTINCT_3',
    name: 'Choose any 3 different Cold Bond drinks',
    selectionMode: 'EXACT_DISTINCT',
    minimumSelections: 3,
    maximumSelections: 3,
    options: [
      ['TR_COLD_CLOUD_BLACK', 'Mini Cloud Black / Mont Blanc', 'TR_COMPONENT_MINI_CLOUD_BLACK_MONT_BLANC'],
      ['TR_COLD_MISO_LATTE', 'Mini Miso Latte', 'TR_COMPONENT_MINI_MISO_LATTE'],
      ['TR_COLD_ICED_CHOCOLATE', 'Single-Origin Iced Chocolate', 'TR_COMPONENT_SINGLE_ORIGIN_ICED_CHOCOLATE'],
    ],
  },
  {
    id: 'TR_ZERO_PROOF_DISTINCT_3',
    name: 'Choose any 3 different zero-proof drinks',
    selectionMode: 'EXACT_DISTINCT',
    minimumSelections: 3,
    maximumSelections: 3,
    options: [
      ['TR_ZERO_MAISON_LEMONADE', 'Mini Maison Lemonade', 'TR_COMPONENT_MINI_MAISON_LEMONADE'],
      ['TR_ZERO_LEMON_OJ_BITTER', 'Lemon OJ Bitter', 'TR_COMPONENT_LEMON_OJ_BITTER'],
      ['TR_ZERO_COCO_MANGO', 'Coco Mango / Mango Matcha', 'TR_COMPONENT_COCO_MANGO_MANGO_MATCHA'],
    ],
  },
  {
    id: 'TR_SET_A_MAIN_CHOICE',
    name: 'Choose Charred Halloumi or one small pizza',
    selectionMode: 'SINGLE',
    minimumSelections: 1,
    maximumSelections: 1,
    options: [
      ['TR_SET_A_HALLOUMI', 'Charred Halloumi', 'TR_CHARRED_HALLOUMI'],
      ['TR_SET_A_BLUE_PIZZA', 'Blue Cheese, Pear & Walnut', 'TR_PIZZA_BLUE_CHEESE_PEAR_WALNUT'],
      ['TR_SET_A_SHROOM_PIZZA', 'Shroom, Cheddar & Parmesan', 'TR_PIZZA_SHROOM_CHEDDAR_PARMESAN'],
      ['TR_SET_A_TOMATO_PIZZA', 'Tomato, Mozzarella', 'TR_PIZZA_TOMATO_MOZZARELLA'],
    ],
  },
  {
    id: 'TR_SET_B_MAIN_CHOICE',
    name: 'Choose one pasta or one small pizza',
    selectionMode: 'SINGLE',
    minimumSelections: 1,
    maximumSelections: 1,
    options: [
      ['TR_SET_B_PASTA_HALLOUMI', 'Pasta Halloumi', 'TR_PASTA_HALLOUMI'],
      ['TR_SET_B_3_CHEESE_PASTA', '3 Cheese Pasta', 'TR_3_CHEESE_PASTA'],
      ['TR_SET_B_BLUE_PIZZA', 'Blue Cheese, Pear & Walnut', 'TR_PIZZA_BLUE_CHEESE_PEAR_WALNUT'],
      ['TR_SET_B_SHROOM_PIZZA', 'Shroom, Cheddar & Parmesan', 'TR_PIZZA_SHROOM_CHEDDAR_PARMESAN'],
      ['TR_SET_B_TOMATO_PIZZA', 'Tomato, Mozzarella', 'TR_PIZZA_TOMATO_MOZZARELLA'],
    ],
  },
];

export const tastingRoomAddOnGroups = groupDefinitions.map((group) => ({
  id: group.id,
  code: group.id,
  name: group.name,
  purpose: 'COMPOSITE_CHOICE',
  selectionMode: group.selectionMode,
  minimumSelections: group.minimumSelections,
  maximumSelections: group.maximumSelections,
  isRequired: true,
  isActive: true,
  previewOnly: true,
  options: group.options.map(([id, name, componentCode], index) => ({
    id,
    code: id,
    name,
    price: 0,
    isActive: true,
    sortOrder: index + 1,
    finishedGoodComponent: ref(componentCode),
  })),
}));

const composites = {
  TR_MINI_AFFOGATO: {
    staticComponents: [ref('TR_COMPONENT_MINI_AFFOGATO_ESPRESSO'), ref('TR_COMPONENT_MINI_AFFOGATO_ICE_CREAM')],
    choiceGroupIds: [],
  },
  TR_COFFEE_THREE_WAYS: {
    staticComponents: [ref('TR_COMPONENT_MINI_ESPRESSO'), ref('TR_COMPONENT_MINI_CORTADO'), ref('TR_COMPONENT_COLD_BREW_MANUAL_BREW')],
    choiceGroupIds: [],
  },
  TR_COLD_BOND_FLIGHT: { staticComponents: [], choiceGroupIds: ['TR_COLD_BOND_DISTINCT_3'] },
  TR_ZERO_PROOF_FLIGHT: { staticComponents: [], choiceGroupIds: ['TR_ZERO_PROOF_DISTINCT_3'] },
  TR_WAKE_UP_WITH_BOND: {
    staticComponents: [ref('TR_COMPONENT_MINI_TROPIC_SHOT'), ref('TR_COMPONENT_EGG_COFFEE'), ref('TR_COMPONENT_SINGLE_ORIGIN_HOT_CHOCOLATE')],
    choiceGroupIds: [],
  },
  TR_SET_A: {
    staticComponents: [ref('TR_ESPRESSO_BUN'), ref('TR_THREE_DIPS'), ref('TR_NUTTY_SALAD'), ref('TR_BROWNIE_GANACHE_SALTED_CREAM')],
    choiceGroupIds: ['TR_SET_A_MAIN_CHOICE'],
    unresolvedCompositeRequirements: [{ name: 'Two miniature drinks', quantity: 2, reason: 'Owner must define the eligible miniature-drink Finished Goods.' }],
  },
  TR_SET_B: {
    staticComponents: [ref('TR_ESPRESSO_BUN'), ref('TR_THREE_CROSTINI'), ref('TR_COTTAGE_CHEESE_PESTO_NUTS'), ref('TR_TIRAMISU_FOR_TWO')],
    choiceGroupIds: ['TR_SET_B_MAIN_CHOICE'],
    unresolvedCompositeRequirements: [{ name: 'Two miniature drinks', quantity: 2, reason: 'Owner must define the eligible miniature-drink Finished Goods.' }],
  },
};

const baseFinishedGood = (code, name, station, sortOrder) => ({
  id: code,
  code,
  name,
  displayName: name,
  posCategoryCode: 'TR_INTERNAL_COMPONENTS',
  posCategoryName: 'INTERNAL COMPONENTS',
  salePrice: 0,
  productionMode: 'MADE_TO_ORDER',
  itemType: 'MADE_TO_ORDER',
  prepStation: station,
  taxRate: 0,
  bom: [],
  bomVersion: 0,
  recipeCost: 0,
  grossMargin: 0,
  cogsPercent: 0,
  sortOrder,
  availableStoreIds: [TASTING_ROOM_STORE_ID],
  isSellable: false,
  isAvailable: false,
  isActive: true,
  setupStatus: 'BOM_PENDING',
  previewOnly: true,
});

const categoryCodeByName = Object.fromEntries(tastingRoomCategories.map((category) => [category.name, category.code]));

export const tastingRoomFinishedGoods = [
  ...menu.map(([code, name, salePrice, categoryName, description], index) => {
    const composite = composites[code];
    const groupIds = composite?.choiceGroupIds || [];
    const optionIdsByGroup = Object.fromEntries(groupIds.map((groupId) => [
      groupId,
      tastingRoomAddOnGroups.find((group) => group.id === groupId)?.options.map((option) => option.id) || [],
    ]));
    return {
      ...baseFinishedGood(code, name, composite ? 'NONE' : 'KITCHEN', (index + 1) * 10),
      description,
      posCategoryCode: categoryCodeByName[categoryName],
      posCategoryName: categoryName,
      salePrice,
      isSellable: true,
      ...(groupIds.length > 0 ? { addOnGroupIds: groupIds, addOnOptionIdsByGroup: optionIdsByGroup } : {}),
      ...(composite ? {
        composite: {
          schemaVersion: 1,
          staticComponents: composite.staticComponents,
          choiceGroupIds: composite.choiceGroupIds,
        },
      } : {}),
      ...(composite?.unresolvedCompositeRequirements
        ? { unresolvedCompositeRequirements: composite.unresolvedCompositeRequirements }
        : {}),
    };
  }),
  ...internalComponents.map(([code, name, station], index) => baseFinishedGood(code, name, station, 1000 + index)),
];

export const tastingRoomInformationalExperiences = [{
  id: 'THE_BOND_TABLE',
  title: 'THE BOND TABLE',
  summary: 'Private · 25 Minutes · Maximum 4 Guests',
  moments: ['01 Welcome', '02 Spread', '03 Garden', '04 Fire', '05 Finish'],
  priceForTwo: 5000,
  additionalGuestPrice: 2000,
  maximumGuests: 4,
  advanceBookingRequired: true,
  prepaymentRequired: true,
  cta: 'Ask about The Bond Table',
  informationalOnly: true,
  createsCartLine: false,
  createsBooking: false,
  createsPayment: false,
}];

const physicalBomRequirements = {
  TR_ESPRESSO_BUN: [['Whipped salty espresso butter', 'ESPRESSO (candidate only)'], ['High-quality bun', null]],
  TR_THREE_DIPS: [['House hummus', 'HUMMUS (candidate only)'], ['Green olive tapenade', null], ['Whipped ricotta dukkah', 'RICOTTA (candidate only)'], ['Warm sourdough', 'SOURDOUGH (candidate only)']],
  TR_GARLIC_CONFIT_LABNEH: [['Garlic confit / garlic oil', null], ['Cultured labneh', null], ['Chilli and parmesan', 'PARMESAN text match only'], ['Toasted sourdough', 'SOURDOUGH (candidate only)']],
  TR_THREE_CROSTINI: [['Tomato, basil and parmesan crostini', 'PARMESAN text match only'], ['Pear, ricotta, pistachio and honey crostini', 'RICOTTA (candidate only)'], ['Olive tapenade, sun-dried tomato and herb crostini', null]],
  TR_COTTAGE_CHEESE_PESTO_NUTS: [['Cottage cheesecake', null], ['Roasted nuts', null], ['Crisp sourdough', 'SOURDOUGH (candidate only)'], ['House pesto', 'PESTO (candidate only)']],
  TR_NUTTY_SALAD: [['Crisp leaves and apple', null], ['Almond, walnut and seed mix', null], ['Parmesan', 'PARMESAN text match only'], ['Date-mustard dressing', null]],
  TR_CHARRED_HALLOUMI: [['Halloumi', 'HALLOUMI text match only'], ['House falafel', 'FALAFEL (candidate only)'], ['Hummus', 'HUMMUS (candidate only)'], ['Dukkah, herbs and sourdough', 'SOURDOUGH (candidate only)']],
  TR_PASTA_HALLOUMI: [['Pasta / spaghetti portion', null], ['Seasonal vegetables', null], ['Parmesan', 'PARMESAN text match only'], ['Halloumi', 'HALLOUMI text match only']],
  TR_3_CHEESE_PASTA: [['Spaghetti portion', null], ['House ricotta', 'RICOTTA (candidate only)'], ['Imported parmesan', 'PARMESAN text match only'], ['Imported cheddar', null]],
  TR_PIZZA_BLUE_CHEESE_PEAR_WALNUT: [['Small white pizza base', 'PIZZA_BASE (candidate only)'], ['Mozzarella and blue cheese', 'MOZZARELLA (candidate only)'], ['Pear and walnut', null], ['Caramelised onion and date glaze', null]],
  TR_PIZZA_SHROOM_CHEDDAR_PARMESAN: [['Small pizza base', 'PIZZA_BASE (candidate only)'], ['Mushroom and caramelised onion', null], ['Cheddar, mozzarella and parmesan', 'MOZZARELLA (candidate only)']],
  TR_PIZZA_TOMATO_MOZZARELLA: [['Small house flour base', 'PIZZA_BASE (candidate only)'], ['Tomato / pizza sauce', 'PIZZA_SAUCE (candidate only)'], ['Mozzarella, basil and rocket', 'MOZZARELLA (candidate only)']],
  TR_TIRAMISU_FOR_TWO: [['Tiramisu portion', 'TIRAMISU / TIRAMISU_INDULGENCE (candidate only)'], ['Mascarpone cream', null], ['Coffee soak and cacao', 'ESPRESSO text match only']],
  TR_BROWNIE_GANACHE_SALTED_CREAM: [['Fudgy brownie', 'BROWNIE (candidate only)'], ['Dark chocolate ganache', 'GANACHE (candidate only)'], ['Salted caramel cream', null]],
  TR_COMPONENT_MINI_AFFOGATO_ESPRESSO: [['Mini espresso recipe and dose', 'ESPRESSO (candidate only)']],
  TR_COMPONENT_MINI_AFFOGATO_ICE_CREAM: [['House vanilla ice-cream portion', 'ICE_CREAM / Vanilla Ice Cream (candidate only)']],
  TR_COMPONENT_MINI_ESPRESSO: [['Mini espresso recipe and dose', 'ESPRESSO (candidate only)']],
  TR_COMPONENT_MINI_CORTADO: [['Mini cortado recipe and portion', 'CORTADO (candidate only)']],
  TR_COMPONENT_COLD_BREW_MANUAL_BREW: [['Cold Brew / Manual Brew recipe decision and portion', 'COLD_BREW / CLASSIC_COLD_BREW (candidate only)']],
  TR_COMPONENT_MINI_CLOUD_BLACK_MONT_BLANC: [['Mini Cloud Black / Mont Blanc recipe and portion', null]],
  TR_COMPONENT_MINI_MISO_LATTE: [['Mini Miso Latte recipe and portion', 'MISO_LATTE (candidate only)']],
  TR_COMPONENT_SINGLE_ORIGIN_ICED_CHOCOLATE: [['Single-Origin Iced Chocolate recipe and portion', null]],
  TR_COMPONENT_MINI_MAISON_LEMONADE: [['Mini Maison Lemonade recipe and portion', 'MASION_LEMONADE spelling variant (candidate only)']],
  TR_COMPONENT_LEMON_OJ_BITTER: [['Lemon OJ Bitter recipe and portion', null]],
  TR_COMPONENT_COCO_MANGO_MANGO_MATCHA: [['Coco Mango / Mango Matcha recipe decision and portion', 'MANGO_MATCHA (candidate only)']],
  TR_COMPONENT_MINI_TROPIC_SHOT: [['Mini Tropic Shot recipe and portion', null]],
  TR_COMPONENT_EGG_COFFEE: [['Egg Coffee recipe and portion', null]],
  TR_COMPONENT_SINGLE_ORIGIN_HOT_CHOCOLATE: [['Single-Origin Hot Chocolate recipe and portion', null]],
};

function physicalGapRows(item) {
  return (physicalBomRequirements[item.code] || []).map(([required, candidate]) => ({
    ITEM: item.displayName,
    'REQUIRED COMPONENT/PREP ITEM': required,
    'KNOWN/UNKNOWN': 'KNOWN',
    'UNIT REQUIRED': 'UNKNOWN',
    'QUANTITY REQUIRED': 'UNKNOWN',
    'EXISTING ITEM MATCH IF FOUND': candidate || 'NONE FOUND',
    'OWNER INPUT REQUIRED': 'YES — approve identity, unit, quantity and exact Tasting Room recipe before availability.',
  }));
}

function compositeGapRows(item) {
  if (!item.composite) return [];
  const rows = item.composite.staticComponents.map((component) => ({
    ITEM: item.displayName,
    'REQUIRED COMPONENT/PREP ITEM': component.finishedGoodCode,
    'KNOWN/UNKNOWN': 'KNOWN',
    'UNIT REQUIRED': 'PCS',
    'QUANTITY REQUIRED': component.quantity,
    'EXISTING ITEM MATCH IF FOUND': `Preview Finished Good ${component.finishedGoodId}`,
    'OWNER INPUT REQUIRED': 'YES — child physical BOM must be approved before availability.',
  }));
  item.composite.choiceGroupIds.forEach((groupId) => {
    const group = tastingRoomAddOnGroups.find((candidate) => candidate.id === groupId);
    rows.push({
      ITEM: item.displayName,
      'REQUIRED COMPONENT/PREP ITEM': group?.name || groupId,
      'KNOWN/UNKNOWN': 'KNOWN',
      'UNIT REQUIRED': 'DISTINCT FINISHED GOOD CHOICE',
      'QUANTITY REQUIRED': group?.minimumSelections || 'UNKNOWN',
      'EXISTING ITEM MATCH IF FOUND': (group?.options || []).map((option) => option.finishedGoodComponent.finishedGoodCode).join(', '),
      'OWNER INPUT REQUIRED': 'YES — every eligible child physical BOM must be approved before availability.',
    });
  });
  (item.unresolvedCompositeRequirements || []).forEach((requirement) => rows.push({
    ITEM: item.displayName,
    'REQUIRED COMPONENT/PREP ITEM': requirement.name,
    'KNOWN/UNKNOWN': 'UNKNOWN',
    'UNIT REQUIRED': 'PCS',
    'QUANTITY REQUIRED': requirement.quantity,
    'EXISTING ITEM MATCH IF FOUND': 'NONE SELECTED — eligible miniature drinks not defined',
    'OWNER INPUT REQUIRED': `YES — ${requirement.reason}`,
  }));
  return rows;
}

export const tastingRoomBomGapReport = tastingRoomFinishedGoods.flatMap((item) => {
  const rows = [...compositeGapRows(item), ...physicalGapRows(item)];
  return rows.length > 0 ? rows : [{
    ITEM: item.displayName,
    'REQUIRED COMPONENT/PREP ITEM': 'Authoritative physical BOM definition',
    'KNOWN/UNKNOWN': 'UNKNOWN',
    'UNIT REQUIRED': 'UNKNOWN',
    'QUANTITY REQUIRED': 'UNKNOWN',
    'EXISTING ITEM MATCH IF FOUND': 'NONE CONFIRMED',
    'OWNER INPUT REQUIRED': 'YES — supply and approve the complete recipe before availability.',
  }];
});

export const tastingRoomCandidateEvidence = {
  searchedFiles: [
    'frontend/data/rawData1.ts',
    'frontend/data/rawData2.ts',
    'frontend/data/rawData3.ts',
    'frontend/data/rawData4.ts',
    'frontend/data/rawData5.ts',
    'scripts/import-kitchen-bom-master.mjs',
    'scripts/import-missing-prep-recipes.mjs',
  ],
  policy: 'Name/code matches are candidates for owner review only. No existing BOM is automatically reused.',
};

export function buildTastingRoomPublicPreviewSnapshot() {
  const displayItems = tastingRoomFinishedGoods.filter((item) => item.isSellable === true);
  const menuItems = Object.fromEntries(displayItems.map((item) => [item.code, {
    id: item.code,
    code: item.code,
    name: item.name,
    displayName: item.displayName,
    description: item.description,
    posCategoryCode: item.posCategoryCode,
    posCategoryName: item.posCategoryName,
    salePrice: item.salePrice,
    prepStation: item.prepStation,
    itemType: item.itemType,
    productionMode: item.productionMode,
    sortOrder: item.sortOrder,
    availableStoreIds: [TASTING_ROOM_STORE_ID],
    ...(item.addOnGroupIds ? {
      addOnGroupIds: item.addOnGroupIds,
      addOnOptionIdsByGroup: item.addOnOptionIdsByGroup,
    } : {}),
    isSellable: true,
    isAvailable: false,
    isActive: true,
  }]));
  const items = Object.fromEntries(displayItems.map((item) => [item.code, {
    itemCode: item.code,
    fgCode: item.code,
    available: false,
    publicStatus: 'SETUP_INCOMPLETE',
    publicMessage: 'Currently unavailable — recipe verification pending',
  }]));
  const addOnGroups = Object.fromEntries(tastingRoomAddOnGroups.map((group) => [group.id, {
    id: group.id,
    name: group.name,
    purpose: group.purpose,
    selectionMode: group.selectionMode,
    minimumSelections: group.minimumSelections,
    maximumSelections: group.maximumSelections,
    isRequired: group.isRequired,
    isActive: group.isActive,
    options: group.options.map((option) => ({
      id: option.id,
      code: option.code,
      name: option.name,
      price: option.price,
      isActive: option.isActive,
      sortOrder: option.sortOrder,
      finishedGoodComponent: option.finishedGoodComponent,
    })),
  }]));
  return {
    storeId: TASTING_ROOM_STORE_ID,
    storeCode: TASTING_ROOM_STORE_ID,
    storeName: tastingRoomPreviewStore.name,
    items,
    menuItems,
    addOnGroups,
    itemCount: displayItems.length,
    availableCount: 0,
    unavailableCount: displayItems.length,
    previewOnly: true,
  };
}

export const tastingRoomPhase1Catalog = {
  schemaVersion: 1,
  targetProject: 'coffee-bond-pos-preview',
  productionProjectForbidden: 'coffee-bond-pos',
  deepLink: '/?store=TASTING_ROOM_29',
  store: tastingRoomPreviewStore,
  productionGuardStore: tastingRoomProductionGuardStore,
  categories: tastingRoomCategories,
  finishedGoods: tastingRoomFinishedGoods,
  addOnGroups: tastingRoomAddOnGroups,
  informationalExperiences: tastingRoomInformationalExperiences,
  bomGapReport: tastingRoomBomGapReport,
  candidateEvidence: tastingRoomCandidateEvidence,
};

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.stdout.write(`${JSON.stringify(tastingRoomPhase1Catalog, null, 2)}\n`);
}
