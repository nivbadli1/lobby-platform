# WhatsApp message templates

Drafts for Meta approval, one file per language (`he.json`). Each entry follows the
shape of the Cloud API "create message template" request (`name`, `language`,
`category`, `components`), so it can be pasted into WhatsApp Manager or posted to
`/{WABA_ID}/message_templates` as is.

- `{{n}}` are positional parameters; `example.body_text` holds sample values (Meta requires them).
- Buttons are quick replies. The webhook receives the button text/payload.
- `ticket_closed_rate` asks for a typed 1-5 reply instead of five buttons.
- A template in another language is a separate Meta submission: add `<lang>.json`
  with the same template names. Until it is approved, recipients with that
  `people.lang` get the Hebrew template.

`tests/templates.test.ts` checks that every required template exists and that the
parameters and examples line up.
