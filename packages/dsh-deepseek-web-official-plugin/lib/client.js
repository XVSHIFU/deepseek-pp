window.__ModuleLoader__.load({
  id: "@deepseek-pp/dsh-deepseek-web-official-plugin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    "use strict";
    var __create = Object.create;
    var __defProp = Object.defineProperty;
    var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames = Object.getOwnPropertyNames;
    var __getProtoOf = Object.getPrototypeOf;
    var __hasOwnProp = Object.prototype.hasOwnProperty;
    var __export = (target, all) => {
      for (var name in all)
        __defProp(target, name, { get: all[name], enumerable: true });
    };
    var __copyProps = (to, from, except, desc) => {
      if (from && typeof from === "object" || typeof from === "function") {
        for (let key of __getOwnPropNames(from))
          if (!__hasOwnProp.call(to, key) && key !== except)
            __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
      }
      return to;
    };
    var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
      // If the importer is in node compatibility mode or this is not an ESM
      // file that has been converted to a CommonJS file using a Babel-
      // compatible transform (i.e. "__esModule" has not been set), then set
      // "default" to the CommonJS "module.exports" for node compatibility.
      isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
      mod
    ));
    var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

    // src/client.ts
    var client_exports = {};
    __export(client_exports, {
      apply: () => apply,
      inject: () => inject
    });
    module.exports = __toCommonJS(client_exports);
    var import_react = __toESM(require("react"), 1);
    var SETTINGS_NAMESPACE = "deepseek-web";
    var inject = ["slots"];
    function DeepSeekWebSettingsCard() {
      return import_react.default.createElement(
        "section",
        {
          "aria-label": "DeepSeek Web",
          "data-dsh-plugin-card": SETTINGS_NAMESPACE,
          style: {
            border: "1px solid var(--dsw-alias-border-l2)",
            borderRadius: "12px",
            padding: "16px"
          }
        },
        import_react.default.createElement("h3", { style: { margin: 0 } }, "DeepSeek Web"),
        import_react.default.createElement(
          "p",
          { style: { marginBottom: 0, color: "var(--dsw-alias-label-tertiary)" } },
          "Uses the signed-in DeepSeek++ browser session. Configure pairing and connection details here before starting a model request."
        )
      );
    }
    function apply(ctx) {
      const slots = ctx.slots;
      slots.inject("settings.plugin.item", () => slots.register({
        name: "settings.plugin.item",
        key: "deepseek-web"
      }, DeepSeekWebSettingsCard));
    }
    return module.exports;
  }
});
