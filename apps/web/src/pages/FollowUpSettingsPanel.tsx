import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Input } from "@rakazo/ui-web";
import { type FormEvent, useEffect, useState } from "react";
import { SettingsGroup } from "../components/SettingsRows";
import type { RpcClient } from "../lib/rpc";
import { useSpaceRpc } from "../lib/space-rpc";

type Preferences = Awaited<ReturnType<RpcClient["preferences"]["followUps"]["get"]>>;

function timeInput(minutes: number) {
  return [Math.floor(minutes / 60), minutes % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function minutesSinceMidnight(value: FormDataEntryValue | null) {
  const [hours, minutes] = String(value).split(":");
  return Number(hours) * 60 + Number(minutes);
}

export function FollowUpSettingsPanel() {
  const rpc = useSpaceRpc();
  const { t } = useLingui();
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"saved" | "error" | null>(null);

  useEffect(() => {
    let active = true;
    void rpc.preferences.followUps.get().then(
      (value) => {
        if (active) setPreferences(value);
      },
      () => {
        if (active) setLoadFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [rpc]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSaving(true);
    setStatus(null);
    try {
      setPreferences(await rpc.preferences.followUps.update({
        followUps: form.has("followUps"),
        quietHoursStart: minutesSinceMidnight(form.get("quietHoursStart")),
        quietHoursEnd: minutesSinceMidnight(form.get("quietHoursEnd")),
        followUpDailyCap: Number(form.get("followUpDailyCap")),
      }));
      setStatus("saved");
    } catch {
      setStatus("error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsGroup title={t`Follow-ups`}>
      {preferences ? (
        <form onSubmit={(event) => void save(event)} className="space-y-3 px-3 py-3">
          <label className="flex items-center gap-2">
            <input type="checkbox" name="followUps" defaultChecked={preferences.followUps} />
            <Trans>Allow follow-ups you agree to in this space</Trans>
          </label>
          <p className="text-body-sm text-muted-foreground">
            <Trans>Quiet hours use your account timezone. Set both times the same to disable quiet hours.</Trans>
          </p>
          <div className="flex flex-wrap gap-3">
            <label>
              <Trans>Quiet hours start</Trans>
              <Input name="quietHoursStart" type="time" required defaultValue={timeInput(preferences.quietHoursStart)} />
            </label>
            <label>
              <Trans>Quiet hours end</Trans>
              <Input name="quietHoursEnd" type="time" required defaultValue={timeInput(preferences.quietHoursEnd)} />
            </label>
            <label>
              <Trans>Daily limit</Trans>
              <Input name="followUpDailyCap" type="number" min={1} max={2147483647} required defaultValue={preferences.followUpDailyCap} />
            </label>
          </div>
          <Button type="submit" size="sm" disabled={saving}><Trans>Save follow-up settings</Trans></Button>
          {status === "saved" ? <p role="status"><Trans>Follow-up settings saved.</Trans></p> : null}
          {status === "error" ? <p role="alert"><Trans>Could not save follow-up settings.</Trans></p> : null}
        </form>
      ) : loadFailed ? (
        <p role="alert"><Trans>Could not load follow-up settings.</Trans></p>
      ) : (
        <p role="status"><Trans>Loading follow-up settings…</Trans></p>
      )}
    </SettingsGroup>
  );
}
