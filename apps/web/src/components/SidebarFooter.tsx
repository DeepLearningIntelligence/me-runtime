import { Trans, useLingui } from "@lingui/react/macro";
import type { NavLink } from "@rakazo/contracts";
import {
  AppMarkStack,
  Button,
  buttonVariants,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@rakazo/ui-web";
import {
  Check,
  ChevronRight,
  Download,
  FolderOpen,
  Gauge,
  Gift,
  KeyRound,
  Link2,
  LogOut,
  Plug,
  ScrollText,
  Settings,
  SquareKanban,
  UserRound,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import type { Organization } from "../lib/organizations";
import { useSidebarUpdate } from "./DesktopUpdates";
import { IconTooltip } from "./IconTooltip";

type Props = {
  mini?: boolean;
  name: string;
  initials: string | null;
  image?: string | null;
  logos?: Array<{ name: string; logo?: string | null }>;
  email?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIntegrations: () => void;
  onSkills: () => void;
  onBoard?: () => void;
  links?: NavLink[];
  onLink?: (link: NavLink) => void;
  onArtifacts: () => void;
  onVault: () => void;
  onPeople: () => void;
  onInvites: () => void;
  onSettings: () => void;
  /**
   * The person's WhatsApp link (ME-RUN-005): the account menu shows the row
   * only when the shell loaded the messaging status. Undefined keeps the menu
   * as it was, so surfaces that never load it are untouched.
   */
  whatsapp?: { connected: boolean; botName: string | null };
  /** How much of the member's allowance is used; the Usage row shows only with one. */
  usage?: string | null;
  /** The breakdown the Usage row opens beside the menu. */
  usageDetails?: ReactNode;
  onUsage?: () => void;
  onLogOut: () => void;
  signingOut: boolean;
  logOutError: string | null;
  organizations?: Organization[];
  activeOrganizationId?: string | null;
  onSwitchOrganization?: (organization: Organization) => void;
};

// Marks are 24px wide, overlap by 2px, and need 2px for the outer ring.
export function sidebarMarkCount(availableWidth: number) {
  return Math.max(0, Math.min(3, Math.floor((availableWidth - 26) / 22) + 1));
}

export function SidebarFooter({
  mini = false,
  name,
  initials,
  image,
  logos = [],
  email,
  open,
  onOpenChange,
  onIntegrations,
  onSkills,
  onBoard,
  links = [],
  onLink,
  onArtifacts,
  onVault,
  onPeople,
  onInvites,
  onSettings,
  whatsapp,
  usage,
  usageDetails,
  onUsage,
  onLogOut,
  signingOut,
  logOutError,
  organizations = [],
  activeOrganizationId,
  onSwitchOrganization,
}: Props) {
  const { t } = useLingui();
  const update = useSidebarUpdate();
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const [markCount, setMarkCount] = useState(3);
  useLayoutEffect(() => {
    const pill = pillRef.current;
    const label = labelRef.current;
    if (!pill || !label || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const style = getComputedStyle(pill);
      const available =
        pill.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight) -
        label.scrollWidth -
        Number.parseFloat(style.columnGap);
      setMarkCount(sidebarMarkCount(available));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(pill);
    observer.observe(label);
    measure();
    return () => observer.disconnect();
  }, [mini]);
  return (
    <div
      data-testid="sidebar-footer"
      className={`flex shrink-0 items-center gap-2 bg-transparent ${mini ? "flex-col px-1 py-2" : "px-2.5 py-3"}`}
    >
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger
          data-testid="user-menu-trigger"
          aria-label={t`Account menu for ${name}`}
          className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-full border border-border bg-sidebar-accent text-body font-medium text-foreground outline-none hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {image && failedImage !== image ? (
            <img
              src={image}
              alt=""
              className="size-full object-cover"
              onError={() => setFailedImage(image)}
            />
          ) : initials ? (
            initials
          ) : (
            <UserRound size={18} aria-hidden="true" />
          )}
        </PopoverTrigger>
        {open ? (
          <PopoverContent
            side="top"
            sideOffset={8}
            align="start"
            className="max-h-(--available-height) w-[295px] max-w-[calc(100vw-69px)] gap-0 overflow-y-auto p-1 *:shrink-0 data-closed:animate-none"
          >
            <div
              data-testid="account-menu-header"
              className="mb-1 min-w-0 border-b border-border px-2.5 py-2.5"
            >
              <p className="truncate text-body font-medium">{name}</p>
              {email && email !== name ? (
                <p className="truncate text-label text-muted-foreground">{email}</p>
              ) : null}
            </div>
            {organizations.length > 1 ? (
              <>
                {organizations.map((organization) => {
                  const active = organization.id === activeOrganizationId;
                  return (
                    <Button
                      key={organization.id}
                      variant="ghost"
                      aria-current={active ? "true" : undefined}
                      className="h-9 w-full justify-between gap-2.5 font-normal"
                      onClick={() => onSwitchOrganization?.(organization)}
                    >
                      <span className="min-w-0 truncate">{organization.name}</span>
                      {active ? <Check aria-hidden="true" strokeWidth={1.75} /> : null}
                    </Button>
                  );
                })}
                <div className="my-1 border-t border-border" />
              </>
            ) : null}
            {whatsapp ? (
              whatsapp.connected ? (
                <div
                  data-testid="whatsapp-menu-row"
                  className="flex h-9 items-center gap-2.5 px-2.5"
                >
                  <WhatsAppMark />
                  <span className="min-w-0 truncate font-normal">WhatsApp</span>
                  <span className="ms-auto min-w-0 truncate text-body-sm text-muted-foreground">
                    {whatsapp.botName ? t`Connected · ${whatsapp.botName}` : t`Connected`}
                  </span>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  className="h-9 w-full justify-start gap-2.5 font-normal"
                  data-testid="whatsapp-menu-row"
                  onClick={onPeople}
                >
                  <WhatsAppMark />
                  <span className="min-w-0 truncate">WhatsApp</span>
                  <span className="ms-auto text-body-sm text-muted-foreground">
                    <Trans>Connect</Trans>
                  </span>
                </Button>
              )
            ) : null}
            {mini ? (
              <Button
                variant="ghost"
                className="h-9 w-full justify-start gap-2.5 font-normal"
                onClick={onIntegrations}
              >
                <Plug className="text-muted-foreground" strokeWidth={1.75} />
                <Trans>Connect tools</Trans>
              </Button>
            ) : null}
            {usage ? (
              <Popover>
                <PopoverTrigger
                  openOnHover
                  delay={80}
                  closeDelay={150}
                  className={`${buttonVariants({ variant: "ghost" })} h-9 w-full justify-start gap-2.5 font-normal`}
                >
                  <Gauge className="text-muted-foreground" strokeWidth={1.75} />
                  <Trans>Usage</Trans>
                  <span className="ms-auto text-body-sm tabular-nums text-muted-foreground">
                    {usage}
                  </span>
                  <ChevronRight className="text-muted-foreground" strokeWidth={1.75} />
                </PopoverTrigger>
                <PopoverContent
                  data-testid="usage-menu"
                  side="right"
                  align="start"
                  sideOffset={8}
                  className="w-80 max-w-[calc(100vw-2rem)] gap-0 p-1"
                >
                  {usageDetails}
                  <div className="my-1 border-t border-border" />
                  <Button
                    variant="ghost"
                    className="h-9 w-full justify-start font-normal"
                    onClick={onUsage}
                  >
                    <Trans>View usage</Trans>
                  </Button>
                </PopoverContent>
              </Popover>
            ) : null}
            <Button
              variant="ghost"
              className="h-9 w-full justify-start gap-2.5 font-normal"
              onClick={onVault}
            >
              <KeyRound className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Vault</Trans>
            </Button>
            <Button
              variant="ghost"
              className="h-9 w-full justify-start gap-2.5 font-normal"
              onClick={onPeople}
            >
              <Users className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>People</Trans>
            </Button>
            <Button
              variant="ghost"
              className="h-9 w-full justify-start gap-2.5 font-normal"
              onClick={onInvites}
            >
              <Gift className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Invites</Trans>
            </Button>
            <Button
              variant="ghost"
              className="h-9 w-full justify-start gap-2.5 font-normal"
              aria-label={t`Settings`}
              onClick={onSettings}
            >
              <Settings className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Settings</Trans>
            </Button>
            <Button
              variant="ghost"
              className="h-9 w-full justify-start gap-2.5 font-normal"
              onClick={onSkills}
            >
              <ScrollText className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Skills</Trans>
            </Button>
            <Button
              variant="ghost"
              className="h-9 w-full justify-start gap-2.5 font-normal"
              onClick={onArtifacts}
            >
              <FolderOpen className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Files</Trans>
            </Button>
            {onBoard ? (
              <Button
                variant="ghost"
                className="h-9 w-full justify-start gap-2.5 font-normal"
                onClick={onBoard}
              >
                <SquareKanban className="text-muted-foreground" strokeWidth={1.75} />
                <Trans>Board</Trans>
              </Button>
            ) : null}
            {links.map((link) => (
              <Button
                key={link.id}
                variant="ghost"
                className="h-9 w-full justify-start gap-2.5 font-normal"
                onClick={() => onLink?.(link)}
              >
                <Link2 className="text-muted-foreground" strokeWidth={1.75} />
                {link.label}
              </Button>
            ))}
            <div className="my-1 border-t border-border" />
            <Button
              variant="ghost"
              className="h-9 w-full justify-start gap-2.5 font-normal"
              disabled={signingOut}
              onClick={onLogOut}
            >
              <LogOut className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Log out</Trans>
            </Button>
            {logOutError ? (
              <p role="alert" className="px-2.5 pt-1 pb-2 text-body-sm text-destructive">
                {logOutError}
              </p>
            ) : null}
          </PopoverContent>
        ) : null}
      </Popover>
      {!mini ? (
        <Button
          variant="outline"
          ref={pillRef}
          onClick={onIntegrations}
          className="h-9 min-w-0 flex-1 justify-between bg-sidebar-accent hover:border-foreground/30 hover:bg-sidebar-accent dark:hover:bg-sidebar-accent"
        >
          <span ref={labelRef} className="min-w-0 truncate">
            <Trans>Connect tools</Trans>
          </span>
          <AppMarkStack marks={logos.slice(0, markCount)} ringClassName="ring-sidebar-accent" />
        </Button>
      ) : null}
      {update.available ? (
        <IconTooltip label={t`Install update`}>
          <Button
            size="icon-lg"
            className="rounded-full"
            aria-label={t`Install update`}
            disabled={update.busy}
            onClick={update.install}
          >
            <Download aria-hidden="true" />
          </Button>
        </IconTooltip>
      ) : null}
    </div>
  );
}

/** WhatsApp's own glyph at row size, monochrome like the icons beside it. */
function WhatsAppMark() {
  return (
    <span
      aria-hidden="true"
      className="grid size-4 shrink-0 place-items-center text-muted-foreground"
    >
      <svg viewBox="0 0 24 24" className="size-4" role="presentation" fill="currentColor">
        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.347-.347.52-.52.174-.174.232-.298.347-.497.116-.199.058-.372-.03-.52-.086-.149-.66-1.59-.905-2.18-.24-.573-.485-.496-.66-.505l-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.263.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.29.173-1.414-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884a9.82 9.82 0 0 1 6.988 2.896 9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L0 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z" />
      </svg>
    </span>
  );
}
