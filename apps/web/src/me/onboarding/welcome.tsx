import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import { AuthFrame, submitClass } from "../../pages/Auth";
import { BRAND_NAME } from "../brand";
import { rememberInviteEntry } from "./entry";

type Welcome =
  | { kind: "loading" }
  | { kind: "ready"; inviterName: string }
  | { kind: "refused"; message: string }
  | { kind: "error"; message: string };

/**
 * The invite landing page (D-RUN-7): it names the inviter, says what the
 * product is in one sentence, and hands the token to the phone door. Nothing
 * here redeems the invitation; redemption happens with account creation, in
 * the sign-in the Continue button leads to.
 */
export function WelcomePage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("invite") ?? "";
  const [welcome, setWelcome] = useState<Welcome>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    if (!token) {
      setWelcome({ kind: "refused", message: t`That invite link is not valid.` });
      return;
    }
    rpc.invites
      .inspect({ token })
      .then((inspection) => {
        if (!active) return;
        if (inspection.ok) {
          rememberInviteEntry();
          setWelcome({ kind: "ready", inviterName: inspection.inviterName });
        } else {
          setWelcome({ kind: "refused", message: inspection.message });
        }
      })
      .catch((error: unknown) => {
        if (active) setWelcome({ kind: "error", message: errorText(error) });
      });
    return () => {
      active = false;
    };
  }, [token]);

  const signInQuery = new URLSearchParams({ invite: token }).toString();

  return (
    <AuthFrame
      onSubmit={(event) => event.preventDefault()}
      title={
        welcome.kind === "ready" ? (
          <Trans>
            {welcome.inviterName} invited you to {BRAND_NAME}
          </Trans>
        ) : (
          <Trans>Welcome to {BRAND_NAME}</Trans>
        )
      }
    >
      {welcome.kind === "loading" ? null : welcome.kind === "ready" ? (
        <>
          <p className="w-full text-center text-body text-muted-foreground">
            <Trans>Your own agents do the work you ask of them, and answer in WhatsApp.</Trans>
          </p>
          <Button
            type="submit"
            size="lg"
            className={submitClass}
            render={<Link to={`/sign-in?${signInQuery}`} />}
          >
            <Trans>Continue</Trans>
          </Button>
        </>
      ) : (
        <>
          <p role="alert" className="w-full text-center text-body text-destructive">
            {welcome.message}
          </p>
          <Button type="submit" size="lg" className={submitClass} render={<Link to="/sign-in" />}>
            <Trans>Sign in</Trans>
          </Button>
        </>
      )}
    </AuthFrame>
  );
}
