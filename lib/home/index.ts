/**
 * Public surface of the Home-customization layer. Components import from
 * here, never from the individual modules — mirrors the convention in
 * lib/tracking, lib/notifications, lib/yir.
 */
export { getHomeConfig, homeConfigStore, setHomeConfig } from "./store";
export {
  DEFAULT_HOME_CONFIG,
  FIRST_PAGE_PATH,
  HOME_CONFIG_KEY,
  isHomeConfig,
  moveSection,
  toggleSection,
} from "./types";
export type { FirstPage, HomeConfig, HomeSectionConfig, HomeSectionId } from "./types";
