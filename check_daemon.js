/*jslint node: true */
"use strict";
var check_daemon = require('ocore/check_daemon.js');

check_daemon.checkDaemonAndNotify('node run.js stable-oswap2-arb');

