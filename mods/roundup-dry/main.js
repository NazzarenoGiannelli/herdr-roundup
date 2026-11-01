// Toggles the GitHub panel's dry run (shared key "roundup.dryRun"): while on, Merge and Comment
// only log the gh commands they would run to "roundup.dryLog". Opened with mod.open:roundup-dry;
// shows the new state for a moment and closes itself. Without an overlay (herdr-app check) it does nothing.
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, closeOverlay, shared, setShared, theme } from "herdr";

export default class GithubDryRun extends View {
  init(_props, cx) {
    this.on = shared("roundup.dryRun") === true;
    const overlay = props()?.overlay;
    if (!overlay) return;
    this.on = !this.on;
    setShared("roundup.dryRun", this.on ? true : null);
    if (this.on) setShared("roundup.dryLog", null);
    cx.timer.after(1800, () => closeOverlay(overlay));
  }
  render(_cx) {
    const t = theme();
    return h_flex().size_full().px(14).items_center().gap(8).rounded(8)
      .bg(t.background).border_1().border_color(this.on ? t.ansi3 : t.border)
      .text_size(13).text_color(this.on ? t.ansi3 : t.foreground)
      .child(div().child(this.on ? "GitHub dry run ON · nothing is merged or posted" : "GitHub dry run OFF · merges and comments are real"));
  }
}
