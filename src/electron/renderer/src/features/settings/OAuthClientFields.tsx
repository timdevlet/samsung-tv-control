import type { Ref } from "react";
import { Field } from "../../components/Field";
import { TextInput } from "../../components/TextInput";

// The SmartThings OAuth client fields inside the collapsed "Advanced" group.
export function OAuthClientFields({
  clientId,
  clientSecret,
  redirectUri,
  onChange,
  clientIdRef,
}: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  onChange: (field: "clientId" | "clientSecret" | "redirectUri", value: string) => void;
  // For the reveal-and-focus behavior when Sign in routes here with no client configured.
  clientIdRef: Ref<HTMLInputElement>;
}) {
  return (
    <>
      <p className="hint">
        Paste the Client ID and Client Secret from your SmartThings OAuth-In app, then use Sign in
        (in the Account group above) to approve access — tokens are stored automatically.
      </p>
      <Field label="Client ID" htmlFor="clientId">
        <TextInput
          id="clientId"
          ref={clientIdRef}
          value={clientId}
          onValueChange={(v) => onChange("clientId", v)}
        />
      </Field>
      <Field label="Client Secret" htmlFor="clientSecret">
        <TextInput
          id="clientSecret"
          type="password"
          value={clientSecret}
          onValueChange={(v) => onChange("clientSecret", v)}
        />
      </Field>
      <Field label="Redirect URI" htmlFor="redirectUri">
        <TextInput
          id="redirectUri"
          value={redirectUri}
          onValueChange={(v) => onChange("redirectUri", v)}
        />
      </Field>
    </>
  );
}
