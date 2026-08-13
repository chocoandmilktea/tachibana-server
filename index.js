var watcher = require("./watcher");
var webapi = require("./webapi");
var scanner = require("./scanner");
var premarketLogger = require("./premarketLogger");

process.on("unhandledRejection", function (err) {
  console.error("[fatal] unhandledRejection:", err);
});

watcher.start();
webapi.start();
scanner.start();
premarketLogger.start();
