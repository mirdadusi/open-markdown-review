// The protocol's Markdown profile explicitly disables automatic URL linkifying.
// markdown-it nevertheless constructs linkify-it and compiles its large Unicode
// expressions. Do not pay that cost in the host-side validation-only bundle.
// Explicit Markdown/HTML links still use the unchanged markdown-it parser.
// Fail closed if shared code ever tries to enable/use the omitted capability.
export default class DisabledAutomaticLinks {
  constructor() {
    return new Proxy(this, {
      get() { throw new Error('Automatic linkifying is disabled in the companion validation profile.'); },
      set() { throw new Error('Automatic linkifying is disabled in the companion validation profile.'); },
    });
  }
}
