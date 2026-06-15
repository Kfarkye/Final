import * as RadixDropdown from "@radix-ui/react-dropdown-menu";
import { type ReactNode, forwardRef } from "react";
import { Check, ChevronRight } from "lucide-react";

/* ────────────────────────────────────────────────────────────────────────
   Content — the frosted, elevated surface.
   ──────────────────────────────────────────────────────────────────────── */
const DropdownMenuContent = forwardRef<
  React.ElementRef<typeof RadixDropdown.Content>,
  React.ComponentPropsWithoutRef<typeof RadixDropdown.Content>
>(({ className = "", sideOffset = 8, ...props }, ref) => (
  <RadixDropdown.Portal>
    <RadixDropdown.Content
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={8}
      className={[
        // ── Layout & sizing ──
        "z-50 min-w-[12rem] overflow-hidden rounded-xl p-1.5",
        // ── Frosted glass: blur + saturate so colors stay rich behind it ──
        "bg-gray-900/80 backdrop-blur-md backdrop-saturate-150",
        // ── True z-depth: hairline border + inner highlight + deep shadow ──
        "border border-gray-700/80",
        "shadow-2xl shadow-black/40",
        "ring-1 ring-inset ring-white/[0.04]", // subtle top-edge light catch
        // ── Motion: origin-aware scale+fade, respects reduced-motion ──
        "origin-[--radix-dropdown-menu-content-transform-origin]",
        "dropdown-content-animation",
        "duration-150 ease-out motion-reduce:animate-none motion-reduce:transition-none",
        className,
      ].join(" ")}
      {...props}
    />
  </RadixDropdown.Portal>
));
DropdownMenuContent.displayName = "DropdownMenuContent";

/* ────────────────────────────────────────────────────────────────────────
   Item — focus-driven (not hover) highlight for true keyboard parity.
   ──────────────────────────────────────────────────────────────────────── */
const itemBase = [
  "group relative flex cursor-default select-none items-center gap-2.5",
  "rounded-md px-2.5 py-2 text-sm text-gray-200 outline-none",
  "transition-colors duration-75",
  // Highlight comes from data-highlighted → identical for mouse & keyboard
  "data-[highlighted]:bg-white/[0.06] data-[highlighted]:text-white",
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
].join(" ");

interface ItemProps
  extends React.ComponentPropsWithoutRef<typeof RadixDropdown.Item> {
  icon?: ReactNode;
  shortcut?: string;
  destructive?: boolean;
}

const DropdownMenuItem = forwardRef<
  React.ElementRef<typeof RadixDropdown.Item>,
  ItemProps
>(({ className = "", icon, shortcut, destructive, children, ...props }, ref) => (
  <RadixDropdown.Item
    ref={ref}
    className={[
      itemBase,
      destructive
        ? "text-red-400 data-[highlighted]:bg-red-500/10 data-[highlighted]:text-red-300"
        : "",
      className,
    ].join(" ")}
    {...props}
  >
    {icon && (
      <span className="flex h-4 w-4 items-center justify-center opacity-70 group-data-[highlighted]:opacity-100">
        {icon}
      </span>
    )}
    <span className="flex-1 truncate">{children}</span>
    {shortcut && (
      <kbd className="ml-auto text-[0.7rem] font-medium tracking-wider text-gray-500 group-data-[highlighted]:text-gray-300">
        {shortcut}
      </kbd>
    )}
  </RadixDropdown.Item>
));
DropdownMenuItem.displayName = "DropdownMenuItem";

/* ────────────────────────────────────────────────────────────────────────
   Checkbox item — animated check, focus-driven highlight.
   ──────────────────────────────────────────────────────────────────────── */
const DropdownMenuCheckboxItem = forwardRef<
  React.ElementRef<typeof RadixDropdown.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof RadixDropdown.CheckboxItem>
>(({ className = "", children, ...props }, ref) => (
  <RadixDropdown.CheckboxItem
    ref={ref}
    className={[itemBase, "pl-8", className].join(" ")}
    {...props}
  >
    <span className="absolute left-2 flex h-4 w-4 items-center justify-center">
      <RadixDropdown.ItemIndicator>
        <Check className="h-3.5 w-3.5 dropdown-check-animation" />
      </RadixDropdown.ItemIndicator>
    </span>
    {children}
  </RadixDropdown.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName = "DropdownMenuCheckboxItem";

/* ────────────────────────────────────────────────────────────────────────
   Submenu — inherits the same frosted surface for visual consistency.
   ──────────────────────────────────────────────────────────────────────── */
const DropdownMenuSubTrigger = forwardRef<
  React.ElementRef<typeof RadixDropdown.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof RadixDropdown.SubTrigger>
>(({ className = "", children, ...props }, ref) => (
  <RadixDropdown.SubTrigger
    ref={ref}
    className={[itemBase, "data-[state=open]:bg-white/[0.06]", className].join(" ")}
    {...props}
  >
    <span className="flex-1 truncate">{children}</span>
    <ChevronRight className="ml-auto h-4 w-4 opacity-60" />
  </RadixDropdown.SubTrigger>
));
DropdownMenuSubTrigger.displayName = "DropdownMenuSubTrigger";

const DropdownMenuSubContent = forwardRef<
  React.ElementRef<typeof RadixDropdown.SubContent>,
  React.ComponentPropsWithoutRef<typeof RadixDropdown.SubContent>
>(({ className = "", ...props }, ref) => (
  <RadixDropdown.Portal>
    <RadixDropdown.SubContent
      ref={ref}
      className={[
        "z-50 min-w-[11rem] overflow-hidden rounded-xl p-1.5",
        "bg-gray-900/80 backdrop-blur-md backdrop-saturate-150",
        "border border-gray-700/80 shadow-2xl shadow-black/40 ring-1 ring-inset ring-white/[0.04]",
        "origin-[--radix-dropdown-menu-content-transform-origin]",
        "dropdown-content-animation",
        "duration-150 ease-out motion-reduce:animate-none",
        className,
      ].join(" ")}
      {...props}
    />
  </RadixDropdown.Portal>
));
DropdownMenuSubContent.displayName = "DropdownMenuSubContent";

/* ────────────────────────────────────────────────────────────────────────
   Label & Separator.
   ──────────────────────────────────────────────────────────────────────── */
const DropdownMenuLabel = forwardRef<
  React.ElementRef<typeof RadixDropdown.Label>,
  React.ComponentPropsWithoutRef<typeof RadixDropdown.Label>
>(({ className = "", ...props }, ref) => (
  <RadixDropdown.Label
    ref={ref}
    className={[
      "px-2.5 pb-1 pt-2 text-[0.7rem] font-semibold uppercase tracking-wider text-gray-500",
      className,
    ].join(" ")}
    {...props}
  />
));
DropdownMenuLabel.displayName = "DropdownMenuLabel";

const DropdownMenuSeparator = forwardRef<
  React.ElementRef<typeof RadixDropdown.Separator>,
  React.ComponentPropsWithoutRef<typeof RadixDropdown.Separator>
>(({ className = "", ...props }, ref) => (
  <RadixDropdown.Separator
    ref={ref}
    className={["-mx-1.5 my-1.5 h-px bg-gray-700/60", className].join(" ")}
    {...props}
  />
));
DropdownMenuSeparator.displayName = "DropdownMenuSeparator";

/* ────────────────────────────────────────────────────────────────────────
   Compound Export Grouping Definitions
   ──────────────────────────────────────────────────────────────────────── */
interface DropdownMenuSubComponents {
  Trigger: typeof RadixDropdown.Trigger;
  Group: typeof RadixDropdown.Group;
  RadioGroup: typeof RadixDropdown.RadioGroup;
  Content: typeof DropdownMenuContent;
  Item: typeof DropdownMenuItem;
  CheckboxItem: typeof DropdownMenuCheckboxItem;
  Sub: typeof RadixDropdown.Sub;
  SubTrigger: typeof DropdownMenuSubTrigger;
  SubContent: typeof DropdownMenuSubContent;
  Label: typeof DropdownMenuLabel;
  Separator: typeof DropdownMenuSeparator;
}

export const DropdownMenu: typeof RadixDropdown.Root & DropdownMenuSubComponents = Object.assign(
  RadixDropdown.Root,
  {
    Trigger: RadixDropdown.Trigger,
    Group: RadixDropdown.Group,
    RadioGroup: RadixDropdown.RadioGroup,
    Content: DropdownMenuContent,
    Item: DropdownMenuItem,
    CheckboxItem: DropdownMenuCheckboxItem,
    Sub: RadixDropdown.Sub,
    SubTrigger: DropdownMenuSubTrigger,
    SubContent: DropdownMenuSubContent,
    Label: DropdownMenuLabel,
    Separator: DropdownMenuSeparator,
  }
);

/* ────────────────────────────────────────────────────────────────────────
   Style Injector (Embedded styling for out-of-the-box Tailwind v4)
   ──────────────────────────────────────────────────────────────────────── */
if (typeof document !== "undefined") {
  const STYLE_ID = "truth-dropdown-menu-keyframes";
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.innerHTML = `
      @keyframes dropdown-slide-in {
        from { opacity: 0; transform: scale(0.95) translateY(-4px); }
        to { opacity: 1; transform: scale(1) translateY(0); }
      }
      @keyframes dropdown-slide-out {
        from { opacity: 1; transform: scale(1) translateY(0); }
        to { opacity: 0; transform: scale(0.95) translateY(-4px); }
      }
      @keyframes dropdown-zoom-in {
        from { opacity: 0; transform: scale(0.75); }
        to { opacity: 1; transform: scale(1); }
      }
      .dropdown-content-animation[data-state="open"] {
        animation: dropdown-slide-in 150ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
      }
      .dropdown-content-animation[data-state="closed"] {
        animation: dropdown-slide-out 100ms ease-in forwards;
      }
      .dropdown-check-animation {
        animation: dropdown-zoom-in 100ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
      }
    `;
    document.head.appendChild(style);
  }
}
