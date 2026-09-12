const {app}=require('electron');
app.setPath('userData',process.argv[2]);
require('../dist-electron/main.js');
