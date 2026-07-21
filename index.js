var watcher = require("./watcher");
var webapi = require("./webapi");

process.on("unhandledRejection", function (err) {
  console.error("[fatal] unhandledRejection:", err);
});

watcher.start();
webapi.start();
