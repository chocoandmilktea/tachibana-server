var watcher = require("./watcher");
var webapi = require("./webapi");
var scanner = require("./scanner");

process.on("unhandledRejection", function (err) {
  console.error("[fatal] unhandledRejection:", err);
});

watcher.start();
webapi.start();
scanner.start();
