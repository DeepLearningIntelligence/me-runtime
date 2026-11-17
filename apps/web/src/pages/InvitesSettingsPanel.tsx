import { Trans, useLingui } from "@lingui/react/macro";
import type { InviteIssued, InviteList } from "@rakazo/contracts";
import { Button, toast } from "@rakazo/ui-web";
import { Copy, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { SettingsGroup } from "../components/SettingsRows";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { BRAND_NAME } from "../me/brand";

/**
 * The link's only home in the app: the token is shown once when minted and the
 * stored hash can never produce it again. The welcome page (the onboarding
 * flow) reads the token from this URL before anyone signs in.
 */
export function inviteLinkUrl(token: string): string {
  return new URL(`/welcome?invite=${encodeURIComponent(token)}`, window.location.origin).href;
}

/** The date a list line shows, in the person's locale. */
function shortDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, { month: "short", day: "numeric" });
}

function expiryDays(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

/** The person's invite meter and the links they minted (ME-RUN-001 D-RUN-7). */
export function InvitesSettingsPanel() {
  const { t, i18n } = useLingui();
  const locale = i18n.locale || "en";
  const [list, setList] = useState<InviteList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<InviteIssued | null>(null);
  const [minting, setMinting] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    rpc.invites
      .list()
      .then((next) => {
        if (active) setList(next);
      })
      .catch((err: unknown) => {
        if (active) setError(errorText(err, t`Could not load your invites.`));
      });
    return () => {
      active = false;
    };
    // Not keyed on `t`: a re-render with fresh strings must not reload the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    try {
      setList(await rpc.invites.list());
      setError(null);
      return true;
    } catch (err) {
      setError(errorText(err, t`Could not load your invites.`));
      return false;
    }
  }

  async function mint() {
    if (minting) return;
    setMinting(true);
    setError(null);
    try {
      setIssued(await rpc.invites.issue());
      await refresh();
    } catch (err) {
      setError(errorText(err, t`Could not create a link.`));
    } finally {
      setMinting(false);
    }
  }

  async function revoke(id: string) {
    if (revokingId) return;
    setRevokingId(id);
    setError(null);
    try {
      await rpc.invites.revoke({ id });
      await refresh();
    } catch (err) {
      setError(errorText(err, t`Could not withdraw the link.`));
    } finally {
      setRevokingId(null);
    }
  }

  async function copy(url: string) {
    try {
      if (!navigator.clipboard) throw new Error("No clipboard");
      await navigator.clipboard.writeText(url);
      toast(t`Invite link copied`);
    } catch (err) {
      setError(errorText(err, t`Could not copy the link.`));
    }
  }

  function share(link: InviteIssued) {
    const url = inviteLinkUrl(link.token);
    const text = t`Come build your agent with me on ${BRAND_NAME}: ${url}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener");
  }

  const quota = list?.quota;
  const used = quota?.grantedCount ?? 0;
  const allocation = quota?.allocation ?? 0;
  const left = Math.max(0, allocation - used);
  const expiryLine = (iso: string) => {
    const days = expiryDays(iso);
    if (days <= 0) return t`Expired`;
    if (days === 1) return t`Expires tomorrow`;
    if (days <= 14) return t`Expires in ${days} days`;
    return t`Expires ${shortDate(iso, locale)}`;
  };
  return (
    <div data-testid="invites-settings" className="space-y-8">
      {error ? <p className="text-body-sm text-destructive">{error}</p> : null}
      <SettingsGroup title={t`Invites`}>
        <div className="px-4 py-3">
          <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-2 text-body text-foreground">
            <span data-testid="invites-meter">
              <Trans comment="The invite meter: links minted of the allowance.">
                {used} of {allocation} used
              </Trans>
            </span>
            <Button size="sm" disabled={minting || left === 0} onClick={() => void mint()}>
              <Plus />
              <Trans>New link</Trans>
            </Button>
          </div>
          {allocation > 0 ? (
            <div
              aria-hidden="true"
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
              role="presentation"
            >
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${Math.min(100, (used / allocation) * 100)}%` }}
              />
            </div>
          ) : null}
          <p className="mt-2 text-body-sm text-muted-foreground">
            {left > 0 ? (
              <Trans>
                {left} left. A person who joins with your link can connect their agent with yours.
              </Trans>
            ) : (
              <Trans>You have used all {allocation}.</Trans>
            )}
          </p>
        </div>
      </SettingsGroup>
      {issued ? (
        <SettingsGroup title={t`Your new link`} data-testid="invites-issued">
          <div className="px-4 py-3">
            <p className="text-body-sm text-muted-foreground">
              <Trans>
                Shown once. Send it to one person; when they join, the meter above moves.
              </Trans>
            </p>
            <code
              data-testid="invites-issued-url"
              className="mt-2 block truncate rounded-lg bg-muted px-2.5 py-1.5 font-mono text-body-sm text-foreground"
            >
              {inviteLinkUrl(issued.token)}
            </code>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => share(issued)}>
                <Trans>Share on WhatsApp</Trans>
              </Button>
              <Button
                size="sm"
                variant="outline"
                aria-label={t`Copy invite link`}
                onClick={() => void copy(inviteLinkUrl(issued.token))}
              >
                <Copy />
                <Trans>Copy</Trans>
              </Button>
            </div>
          </div>
        </SettingsGroup>
      ) : null}
      {list && list.invites.length > 0 ? (
        <SettingsGroup title={t`Minted links`} data-testid="invites-list">
          {list.invites.map((invite) => (
            <div key={invite.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="min-w-0 text-body text-foreground/75">
                <span className="text-foreground">
                  {invite.status === "issued"
                    ? t`Active`
                    : invite.status === "redeemed"
                      ? t`Used`
                      : t`Revoked`}
                </span>
                <span className="ml-2 text-label text-muted-foreground/70">
                  {invite.status === "issued"
                    ? expiryLine(invite.expiresAt)
                    : invite.status === "redeemed" && invite.redeemedAt
                      ? t`Used ${shortDate(invite.redeemedAt, locale)}`
                      : t`Created ${shortDate(invite.createdAt, locale)}`}
                </span>
              </span>
              {invite.status === "issued" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={revokingId === invite.id}
                  onClick={() => void revoke(invite.id)}
                >
                  <Trans>Withdraw</Trans>
                </Button>
              ) : null}
            </div>
          ))}
        </SettingsGroup>
      ) : null}
    </div>
  );
}
