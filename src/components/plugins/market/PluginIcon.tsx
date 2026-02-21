import { builtinPlugins } from "@/plugins/builtin";
import { PluginsIcon } from "@/components/icons/animated";
import type {
  PluginInstance,
  PluginMarketApp,
} from "@/core/plugin-system/types";

interface PluginAppIconProps {
  plugin?: PluginInstance | PluginMarketApp | null;
  size?: "small" | "normal" | "large";
}

export function PluginAppIcon({ plugin, size = "normal" }: PluginAppIconProps) {
  let wrapperClass = "";
  let iconClass = "";
  let textClass = "";

  if (size === "small") {
    wrapperClass = "w-7 h-7 rounded-md";
    iconClass = "w-3.5 h-3.5";
    textClass = "text-[10px]";
  } else if (size === "normal") {
    wrapperClass = "w-9 h-9 rounded-lg";
    iconClass = "w-4 h-4";
    textClass = "text-xs";
  } else if (size === "large") {
    wrapperClass = "w-10 h-10 rounded-lg";
    iconClass = "w-5 h-5";
    textClass = "text-sm";
  }

  const baseWrapperClass = `${wrapperClass} flex items-center justify-center shrink-0`;

  if (!plugin) {
    return (
      <div className={`${baseWrapperClass} bg-gray-500/10 text-gray-400`}>
        <PluginsIcon className={iconClass} />
      </div>
    );
  }

  const isPluginInstance = (value: PluginInstance | PluginMarketApp): value is PluginInstance =>
    "manifest" in value;
  const isOfficial =
    plugin.isOfficial ||
    (isPluginInstance(plugin) && plugin.source === "official");
  const slug = (plugin.slug || "").toLowerCase();

  // 1. If it's an official plugin with specific icon
  if (isOfficial && slug) {
    const builtin = builtinPlugins.find(
      (p) => p.id === slug || p.viewId === slug,
    );
    if (builtin && builtin.icon) {
      const svgClasses = iconClass
        .split(" ")
        .map((c) => `[&_svg]:${c}`)
        .join(" ");
      return (
        <div className={`${baseWrapperClass} ${builtin.color} ${svgClasses}`}>
          {builtin.icon}
        </div>
      );
    }
  }

  // 2. Fallback for non-official plugins
  const name = isPluginInstance(plugin)
    ? plugin.manifest.pluginName || ""
    : plugin.name || "";

  const shortName = name.slice(0, 2);
  const colorClass = isOfficial
    ? "bg-orange-400/15 text-orange-300"
    : "bg-indigo-500/15 text-indigo-300";

  if (shortName) {
    return (
      <div
        className={`${baseWrapperClass} ${colorClass} ${textClass} font-semibold`}
      >
        {shortName}
      </div>
    );
  }

  return (
    <div className={`${baseWrapperClass} ${colorClass}`}>
      <PluginsIcon className={iconClass} />
    </div>
  );
}
