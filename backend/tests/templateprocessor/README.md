# TemplateProcessor Test Plan

## Backend Test Cases

| Bereich | Fall | Setup | Erwartung |
| --- | --- | --- | --- |
| Auflösung | Output via `properties` | Template A setzt `oci_image` per `properties` | `getUnresolvedParameters` enthält `oci_image` **nicht** |
| Auflösung | Output via `outputs` | Template A setzt `vm_id` via `outputs` | Parameter resolved |
| Defaults | Default vorhanden | `default: "x"` | nicht unresolved |
| Required | Required ohne Default | `required: true` | unresolved |
| Skips | `skip_if_property_set` | Param gesetzt | Template skipped, outputs nicht gesetzt |
| Skips | `skip_if_all_missing` | alle fehlen | Template skipped, Parameter sichtbar, unresolved |
| Skips | `skip_if_all_missing` + Input | mind. 1 vorhanden | Template läuft, outputs gesetzt |
| Konflikte | Output doppelt (non‑conditional) | A+B setzen selben Output | Fehler |
| Konflikte | Output doppelt (conditional) | einer conditional | kein Fehler, letzter wins |
| Trace | Template trace origin/path | json/local/shared | Symbolische Pfade korrekt |
| Trace | Parameter trace source | user/default/output/properties/missing | source korrekt |
| Unresolved | Trace‑Filterung | `parameterTrace` vorhanden | nur `source="missing"` als unresolved |
| veContext | gültig (UI) | VE vorhanden | enum exec möglich |
| veContext | ungültig (validation) | VE fehlt | enum exec übersprungen |
| Enum | 0 Werte | enum template liefert 0 | enumValues leer, required → unresolved |
| Enum | 1 Wert | enum template liefert 1 | default gesetzt |
| Enum | >1 Wert | enum template liefert >1 | kein default |

## Frontend Test Cases

| Bereich | Fall | Setup | Erwartung |
| --- | --- | --- | --- |
| Advanced | `advanced=false`, `required=false` | optionaler Parameter | Feld sichtbar, kein Missing‑Hint |
| Advanced | `advanced=true`, `required=false` | optional + advanced | versteckt bis Toggle |
| Missing‑Hint | required fehlt | required ohne Default/Output | **Kein** Warnhinweis; Feld sichtbar und darf leer sein (NOT_DEFINED) |
| Missing‑Hint | required resolved | resolved via properties/output/default | Warnbox **nicht** sichtbar |
| Trace‑Dialog | Tabelle Templates | traceInfo vorhanden | Tabelle zeigt Origin/Path |
| Trace‑Dialog | Parameter‑Tabelle | parameterTrace vorhanden | Set by/Used in korrekt |
| Trace‑Dialog | Filter | IDs via Komma | Filter wirkt |
| Default | Default gesetzt | param.default | Feld vorbefüllt |
| Unresolved | resolved durch properties | trace source `template_properties` | kein Missing‑Hint |
| Fehler | Trace‑API Fehler | 500 | ErrorHandler zeigt Fehler |

## veContext‑spezifische Tests (Unresolved)

| Fall | veContext | Setup | Erwartung |
| --- | --- | --- | --- |
| Enum (0 Werte) | gültig | enum template liefert 0 | `unresolved` **enthält** Param |
| Enum (1 Wert) | gültig | enum template liefert 1 | `unresolved` **enthält nicht** Param (default gesetzt) |
| Enum (>1 Wert) | gültig | enum template liefert >1 | `unresolved` **enthält** Param |
| Enum (beliebig) | ungültig/fehlt | enum template würde liefern | `unresolved` **enthält** Param (exec übersprungen) |

## Kombinations‑Tests

| Kombination | Begründung | Testebene |
| --- | --- | --- |
| enumValues × advanced | UI Toggle + Backend default bei 1 Wert | Frontend + Backend |
| enumValues × required | required + 0/1/n Werte → unresolved/auto‑default | Backend |
| skip_if_all_missing × required | UI zeigt Parameter trotz skip, Backend setzt keine outputs | Backend + Frontend |
| properties‑output × trace | Trace zeigt `template_properties`, unresolved entfernt | Backend |
| default × advanced | Default + Advanced, UI prefill + toggle | Frontend |
| Enum-Exec möglich | gültig | enumValuesTemplate | enum exec, Werte ggf. gesetzt | Unterschied nur mit VE |
| Enum-Exec übersprungen | ungültig/fehlt | enumValuesTemplate | keine Ausführung, `enumValues` leer | Validierungsmodus |
| Default bei 1 Wert | gültig | enum template liefert 1 | `default` gesetzt | UI/Unresolved abhängig |
| Kein Default ohne VE | ungültig/fehlt | enum template liefert 1 | `default` leer | erwartet |
| Exec-Fehler | gültig | enum script wirft | Error erfasst, kein Hang | Stabilität |
| Kein Fehler ohne VE | ungültig/fehlt | enum script wirft | kein Exec, kein Fehler | validiert Skip |

## Kombinations-Tests

| Kombination | Begründung | Ebene |
|---|---|---|
| enumValues × advanced | UI Toggle + Backend Default-Logik | FE + BE |
| enumValues × required | required + 0/1/n Werte | BE |
| skip_if_all_missing × required | Parameter sichtbar trotz Skip | FE + BE |
| properties-output × trace | Trace `template_properties`, unresolved entfernt | BE |
| default × advanced | Default + Advanced Toggle | FE |
