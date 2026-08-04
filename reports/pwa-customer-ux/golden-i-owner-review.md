# Golden I Dietary and Category Owner Review

Generated: 2026-08-04
Status: **OWNER DECISIONS REQUIRED**
Mode: read-only; no Firestore writes

## Evidence Sources

- `publicMenuAvailability/GOLDEN_I`: 80 active/sellable public products.
- `finishedGoods`: exact Finished Good found for all 80 public products.
- `prepItems` and `rawIngredients`: recursively inspected to resolve BOM leaves.
- No approved Coffee Bond workbook file is present in this worktree, so this report does not claim workbook evidence.
- No product, ingredient, prep item, or public snapshot contains a trusted dietary field sufficient to label a vegetarian product automatically.

## Conservative Classification Summary

| Classification | Count | Meaning |
|---|---:|---|
| Clearly vegetarian from trusted source | 0 | Every resolved leaf would need trusted vegetarian metadata |
| Clearly contains egg | 15 | Recursive BOM reaches explicit `rawIngredients/EGG` or `EGGS` |
| Clearly non-vegetarian | 0 | Recursive BOM reaches an explicit meat/fish ingredient |
| Ambiguous | 53 | BOM resolves, but leaf ingredients lack trusted dietary metadata |
| Missing source evidence | 12 | Empty/incomplete final BOM or unresolved dependency prevents classification |

This deliberately does not infer dietary status from product names. The only automatic recommendation is `EGG` where the authoritative recursive BOM explicitly reaches the Egg raw ingredient. All other rows remain blank pending owner-approved evidence.

## Dietary Review

| Record | Current Value | Problem | Recommended Value | Confidence | Owner Decision Required |
|---|---|---|---|---|---|
| `finishedGoods/AFFOGATO` | Not present | No dietary field is stored; BOM trace reaches explicit raw ingredient EGG. | EGG | HIGH | YES |
| `finishedGoods/AVOCADO_AND_QUINOA_SALAD` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/AVOCADO_BREAKFAST_BOWL` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/BEACH_BREW` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/BERRY_SMOOTHIE_BOWL` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/BOND_FRAPPE` | Not present | No dietary field is stored; BOM trace reaches explicit raw ingredient EGG. | EGG | HIGH | YES |
| `finishedGoods/BOND_PIZZA` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/BREAD_2_SLICES` | Not present | The final Finished Good BOM is empty, so dietary status cannot be traced to ingredients. | LEAVE BLANK until a complete approved BOM or dietary source is supplied | HIGH | YES |
| `finishedGoods/BROWNIE` | Not present | No dietary field is stored; BOM trace reaches explicit raw ingredient EGG. | EGG | HIGH | YES |
| `finishedGoods/CAPPUCCINO` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/CHEESE_GARLIC_BREAD` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/CHILLI_CRISP_HUNG_CURD_FOLD` | Not present | The final Finished Good BOM is empty, so dietary status cannot be traced to ingredients. | LEAVE BLANK until a complete approved BOM or dietary source is supplied | HIGH | YES |
| `finishedGoods/CLASSIC_COLD_BREW` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/CLASSIC_ZAFFLE` | Not present | No dietary field is stored; BOM trace reaches explicit raw ingredient EGG. | EGG | HIGH | YES |
| `finishedGoods/CLOUD_BLACK` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/COCO_MANGO` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/COCONUT_VIETNAMESE` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/COLD_BREW_TONIC` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/COLD_COFFEE` | Not present | No dietary field is stored; BOM trace reaches explicit raw ingredient EGG. | EGG | HIGH | YES |
| `finishedGoods/COOKIE_HAZELNUT_CHOCOLATE` | Not present | No dietary field is stored; BOM trace reaches explicit raw ingredient EGG. | EGG | HIGH | YES |
| `finishedGoods/CORTADO` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/DOUBLE_ESPRESSO` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/ESPRESSO_TONIC` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/EXTRA_DIP` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/FLAT_WHITE` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/FOCUS_LATTE` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/FRENCH_PRESS` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/FRUIT_SALAD_GRANOLA_YOGURT` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/GARLIC_BREAD` | Not present | The final Finished Good BOM is empty, so dietary status cannot be traced to ingredients. | LEAVE BLANK until a complete approved BOM or dietary source is supplied | HIGH | YES |
| `finishedGoods/GINGER_LEMON_HONEY` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/GREEN` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/HERBAL` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/HOJI_MAPLE_LATTE` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/HOMEMADE_ICED_TEA` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/HONG_KONG_GUNNER` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/HUMMUS_VEGGIES` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/HUMMUS_GREENS_AND_PICKLED_ONION` | Not present | The final Finished Good BOM is empty, so dietary status cannot be traced to ingredients. | LEAVE BLANK until a complete approved BOM or dietary source is supplied | HIGH | YES |
| `finishedGoods/HUNG_CURD__CHARED_VEG_TARTINE` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/ICED_AMERICANO` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/ICED_CAPPUCCINO` | Not present | The final Finished Good BOM is empty, so dietary status cannot be traced to ingredients. | LEAVE BLANK until a complete approved BOM or dietary source is supplied | HIGH | YES |
| `finishedGoods/ICED_LATTE` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/ICED_VIETNAMESE` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/KALE_RICOTTA_TOAST` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/KIMCHI_FRIED_RICE` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/LATTE` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/LEMON_ICE_CREAM` | Not present | No dietary field is stored; BOM trace reaches explicit raw ingredient EGG. | EGG | HIGH | YES |
| `finishedGoods/LEMON_OJ_BITTER` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/LONG_BLACK` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/MACCHIATO` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/MAGIK` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/MAISON_LEMONADE` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/MANGO_ICE_CREAM` | Not present | No dietary field is stored; BOM trace reaches explicit raw ingredient EGG. | EGG | HIGH | YES |
| `finishedGoods/MANGO_MATCHA` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/MARGHERITA` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/MATCHA_LATTE_HOT_ICED` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/MEDITERRANEAN_MEZZE_PLATTER` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/MISO_LATTE` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/MIX_BUSINESS` | Not present | The final Finished Good BOM is empty, so dietary status cannot be traced to ingredients. | LEAVE BLANK until a complete approved BOM or dietary source is supplied | HIGH | YES |
| `finishedGoods/MIXED_BUSINESS_ZAFFLE` | Not present | No dietary field is stored; BOM trace reaches explicit raw ingredient EGG. | EGG | HIGH | YES |
| `finishedGoods/MOZZARELLA_PESTO` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/MR_PESTO` | Not present | The final Finished Good BOM is empty, so dietary status cannot be traced to ingredients. | LEAVE BLANK until a complete approved BOM or dietary source is supplied | HIGH | YES |
| `finishedGoods/MR_PINK` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/MR_RED` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/MR_WHITE` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/PANCAKES` | Not present | No dietary field is stored; BOM trace reaches explicit raw ingredient EGG. | EGG | HIGH | YES |
| `finishedGoods/POTATO_ONION_ZAFFLE` | Not present | No dietary field is stored; BOM trace reaches explicit raw ingredient EGG. | EGG | HIGH | YES |
| `finishedGoods/POUR_OVER` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/PROTEIN_NACHOS` | Not present | The final Finished Good BOM is empty, so dietary status cannot be traced to ingredients. | LEAVE BLANK until a complete approved BOM or dietary source is supplied | HIGH | YES |
| `finishedGoods/ROASTED_FRIES` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/SEASONAL_JUICE` | Not present | The final Finished Good BOM is empty, so dietary status cannot be traced to ingredients. | LEAVE BLANK until a complete approved BOM or dietary source is supplied | HIGH | YES |
| `finishedGoods/SHROOM_ZAFFLE` | Not present | No dietary field is stored; BOM trace reaches explicit raw ingredient EGG. | EGG | HIGH | YES |
| `finishedGoods/THE_GREEN_HARISSA_SMASH` | Not present | The final Finished Good BOM is empty, so dietary status cannot be traced to ingredients. | LEAVE BLANK until a complete approved BOM or dietary source is supplied | HIGH | YES |
| `finishedGoods/THE_MELBOURNE_FOLD` | Not present | No dietary field is stored; BOM trace reaches explicit raw ingredient EGG. | EGG | HIGH | YES |
| `finishedGoods/THE_MIGHTY_MUSHROOM` | Not present | The final Finished Good BOM is empty, so dietary status cannot be traced to ingredients. | LEAVE BLANK until a complete approved BOM or dietary source is supplied | HIGH | YES |
| `finishedGoods/TIRAMISU` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/TRES_LECHES_NUTTY` | Not present | The final Finished Good BOM is empty, so dietary status cannot be traced to ingredients. | LEAVE BLANK until a complete approved BOM or dietary source is supplied | HIGH | YES |
| `finishedGoods/VANILLA_ICE_CREAM` | Not present | No dietary field is stored; BOM trace reaches explicit raw ingredient EGG. | EGG | HIGH | YES |
| `finishedGoods/VEGGIES` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/WATERMELON_AND_RICOTTA` | Not present | The BOM resolves, but ingredient master records have no trusted dietary metadata and no explicit egg/non-vegetarian leaf proves a classification. | LEAVE BLANK pending owner or supplier dietary evidence | LOW | YES |
| `finishedGoods/WATERMELON_ICE_CREAM` | Not present | No dietary field is stored; BOM trace reaches explicit raw ingredient EGG. | EGG | HIGH | YES |

## Category Review

| Record | Current Value | Problem | Recommended Value | Confidence | Owner Decision Required |
|---|---|---|---|---|---|
| `finishedGoods/BOND_FRAPPE` | MIS / Misc | Deterministic UI mapping shows Other, while BOM evidence establishes a coffee/milk beverage | Owner confirmation required; safest existing candidate is CCF / Cold Crafted | MEDIUM | YES |
| `finishedGoods/MEDITERRANEAN_MEZZE_PLATTER` | ESP / Espresso Bar | Deterministic UI mapping shows Coffee, while BOM evidence establishes a chickpea/pita/tahini platter | Owner confirmation required; safest existing candidate is ZAF / Zaffle & Bites | MEDIUM | YES |

## Decision Safety

- No dietary or category value was written to Firestore.
- No product was classified vegetarian from its name.
- The 15 Egg recommendations are supported by explicit recursive BOM evidence.
- The 53 ambiguous and 12 missing-evidence products remain intentionally unlabeled.
- Category recommendations are candidates only and require explicit owner approval.
