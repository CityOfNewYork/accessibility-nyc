// rule-info.js — Plain-language explanations for the axe-core rules this
// scanner surfaces, keyed by axe rule id.
//   title  — a short plain-language subtitle shown under the axe help text;
//            explains the rule in everyday words for non-experts
//   plain  — what is actually wrong, in everyday words (no jargon)
//   impact — who it hurts, named as real people (blind and low-vision New
//            Yorkers, people with limited dexterity, etc.) — not "screen-reader
//            users" or other tech labels
// The dashboard shows the axe help text as the headline with title as an
// explanatory subtitle, and plain + impact in the expanded card. Hand-written;
// the scanners only ever regenerate results.js, never this file.

window.RULE_INFO = {
  "aria-allowed-attr": {
    title: "An accessibility attribute doesn't apply to this type of element",
    plain: "A component carries an accessibility instruction that isn't valid for what it is — like a \"currently selected\" state attached to something that was never selectable.",
    impact: "Blind and low-vision New Yorkers get a misleading picture of the page — the component may be described as the wrong kind of control, or its instruction ignored entirely.",
  },
  "aria-hidden-focus": {
    title: "Keyboard reaches hidden content",
    plain: "An element is hidden from blind and low-vision users, but a keyboard user can still tab into it.",
    impact: "A blind, low-vision, or keyboard-only New Yorker lands on a control that has been declared invisible — focus seems to vanish, with nothing announced. Disorienting, and easy to get stuck.",
  },
  "aria-input-field-name": {
    title: "Unlabeled input field",
    plain: "A custom input — a dropdown, combo box, or similar — has no label saying what it is for.",
    impact: "A blind or low-vision New Yorker reaches the field with no idea of its purpose — borough? service? date? — and so cannot fill it in.",
  },
  "aria-prohibited-attr": {
    title: "An element has a label or description that isn't allowed on it",
    plain: "An element was given an accessibility name or description it is not allowed to have.",
    impact: "Blind and low-vision New Yorkers can be left with no description of the element at all — the label gets discarded.",
  },
  "aria-required-attr": {
    title: "A control is missing state info, like its current value or on/off state",
    plain: "A control presents itself as a specific kind of widget — a slider, a tab, a toggle — but is missing information that kind of widget needs, such as whether it is currently on or off.",
    impact: "Blind and low-vision New Yorkers meet a half-described, broken control. They cannot tell its current state or what it will do, so they cannot use it with confidence — or at all.",
  },
  "aria-required-children": {
    title: "A widget like a menu or dropdown is missing its required inner parts",
    plain: "A component announces itself as a structured widget (a menu, a list of options) but does not contain the parts that kind of widget requires.",
    impact: "Blind and low-vision New Yorkers meet an empty or broken widget — a \"list box\" with nothing to pick — and cannot operate it.",
  },
  "button-name": {
    title: "Unlabeled buttons",
    plain: "A button has no readable text and no label — often an icon-only button.",
    impact: "A blind or low-vision New Yorker gets only \"button\" with no idea what it does — submit a search? close a window? — so they cannot safely use it.",
  },
  "color-contrast": {
    title: "Text too faint to read",
    plain: "Text is too light against its background to meet the minimum contrast for comfortable reading.",
    impact: "People with low vision or aging eyesight — and anyone using a phone in bright sunlight — struggle to read the text, or cannot read it at all.",
  },
  "document-title": {
    title: "Page has no title",
    plain: "The page has no title.",
    impact: "Blind and low-vision New Yorkers get nothing identifying the page when it loads, and anyone with several tabs open cannot tell which one this is.",
  },
  "frame-title": {
    title: "An embedded frame (often a map or video) has no name",
    plain: "An embedded frame — often a map or a video — has no name saying what it contains.",
    impact: "A blind or low-vision New Yorker reaches it and gets only \"frame\" — no clue whether it holds a map, an ad, or important content.",
  },
  "html-has-lang": {
    title: "The page doesn't say what language it's written in",
    plain: "The page never states what language it is written in.",
    impact: "Blind and low-vision New Yorkers may have the page read aloud in the wrong accent or pronunciation, and automatic translation works less reliably — hurting the people who depend on either.",
  },
  "image-alt": {
    title: "Images with no description",
    plain: "An image has no text description.",
    impact: "A blind or low-vision New Yorker gets nothing where the image is. If it is a chart, a logo, or a photo that carries meaning, that information is simply missing for them.",
  },
  "input-button-name": {
    title: "Unlabeled form button",
    plain: "A form button built from an <input> element — often a Submit or Search button — has no readable text.",
    impact: "A blind or low-vision New Yorker reaches the button with no idea what it does, so they cannot tell how to submit the form or run the search.",
  },
  "label": {
    title: "Form fields with no labels",
    plain: "A form field — a text box, checkbox, or dropdown — has no label, so nothing says what to enter or choose.",
    impact: "A blind or low-vision New Yorker filling out a form cannot tell what a field is for — name? amount? property type? — and may enter the wrong information, or be unable to finish the form at all.",
  },
  "link-name": {
    title: "Links with no text",
    plain: "A link has no readable text — usually an icon or image used as a link with no label.",
    impact: "Blind and low-vision New Yorkers get just \"link\" with no destination. Those who move through a page link by link hit a run of unlabeled links and cannot tell where any of them lead.",
  },
  "list": {
    title: "The list contains items that aren't valid list entries",
    plain: "A list is built incorrectly — it contains items that are not proper list entries.",
    impact: "Blind and low-vision New Yorkers lose the structure that helps them move through related items — the list may not be recognized as a list, or may be counted wrong.",
  },
  "listitem": {
    title: "A list item sits outside of any list",
    plain: "A list item is sitting on its own, not inside an actual list.",
    impact: "Blind and low-vision New Yorkers miss that the items belong together — the stray item is not recognized as part of a list.",
  },
  "meta-refresh": {
    title: "Page reloads itself automatically",
    plain: "The page is set to reload or redirect itself automatically after a delay.",
    impact: "The page can refresh out from under someone mid-read or mid-task — especially harmful for people who read slowly, are blind or low-vision, or have a cognitive disability, who lose their place or their work.",
  },
  "meta-viewport": {
    title: "Zoom is disabled",
    plain: "The page prevents people from pinch-zooming to make it bigger.",
    impact: "People with low vision cannot enlarge the text — a basic adjustment they rely on, taken away. Especially significant for older adults on phones.",
  },
  "role-img-alt": {
    title: "Icon with no description",
    plain: "Something marked up as an image — often an icon — has no text description.",
    impact: "A blind or low-vision New Yorker gets nothing for it. If the icon carries meaning, like a warning or a status, that meaning is lost.",
  },
  "select-name": {
    title: "Unlabeled dropdown menu",
    plain: "A dropdown menu has no label saying what it is for.",
    impact: "A blind or low-vision New Yorker reaches the dropdown unable to tell what it controls, so they cannot make a confident choice.",
  },
  "target-size": {
    title: "Buttons and links are too small to tap reliably",
    plain: "A tappable control — a button, link, or checkbox — is smaller than the minimum recommended size.",
    impact: "People with hand tremors, arthritis, or limited dexterity — common among older adults — cannot tap it reliably, and may trigger the wrong thing.",
  },
  "valid-lang": {
    title: "The page specifies a language code that doesn't exist",
    plain: "An element declares its language using a code that is not a real, recognized language.",
    impact: "Blind and low-vision New Yorkers may have that content read aloud with the wrong accent or sounds, making it hard to follow.",
  },
};
