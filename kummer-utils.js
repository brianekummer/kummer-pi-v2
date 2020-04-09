// My utilities that I commonly use
// June 2017
//
// Required NPM Packages
// ---------------------
// - MomentJS........For date logic
//                   npm install moment
// - String format...To simplify formatting strings in JavaScript
//                   npm install string-format
// - Winston.........Logging framework
//                   npm install winston
// - Crypto..........For encrypting/decrypting secrets file
//                   is included in NodeJS
// - NodeMailer......For sending emails
//                   npm install nodemailer
//
//
// Notes
// -----
//   - NextCloud Notes API (https://github.com/nextcloud/notes/wiki/Notes-0.2)
//      - Need to use "Basic Auth" (add username and password to header)
//      - To get all notes, use url https://cluckcluck.us/index.php/apps/notes/api/v0.2/notes


const PHONE_MESSAGE_EXPIRATION = 21600;       // Message to phone expires after 6 hours

var PLATFORM = process.platform;     // win32|linux
var RUNNING_ON_WINDOWS = (PLATFORM.match(/win32/i) != null);

var moment = require("moment");
var fs = require("fs");
var format = require("string-format");
var logger = require("winston");
var child_process = require("child_process");
var path = require("path");
var os = require("os");


var nodeenvconfiguration = require('node-env-configuration');
var _configuration = nodeenvconfiguration({
  //defaults: defaultConfiguration,
  prefix: 'ku'
});
if (Object.keys(_configuration).length === 0)
  throw new Error("Missing configuration data in environment variables");


var _today = moment().startOf("day");
var _tomorrow = _today.clone().add(1, "day");

logger.level = "verbose";   //"error";

// Adding properties named "allMembers" and "restOfMembers" to 
// _configuration.family that are arrays
_configuration.family.allMembers = [];
_configuration.family.restOfMembers = [];
for (var key in _configuration.family) {
  var fm = _configuration.family[key];
  if (fm.hasOwnProperty("name")) {
    _configuration.family.allMembers.push(fm);
    if (fm.name != "Brian")
      _configuration.family.restOfMembers.push(fm);
  }
}




function configureLogger(logger, jsFileName) {
  logger.level = getLogLevelFromParameters("error");
  logger.add(logger.transports.File, {
    json: false,
    formatter: logFormatter,
    filename: jsFileName.replace(/.js$/i, ".log") });
}


function logFormatter(args) {
  return format("{0} {1}{2}: {3}",
    moment().format("YYYY-MM-DD HH:mm:ss.SSS"),
    args.level,
    " ".repeat(7-args.level.length),
    args.message);
}


function getLogLevelFromParameters(defaultValue) {
  // Look for loglevel in parameters.
  // Valid values for loglevel are error|warn|info|verbose
  // If there is no logging level in the parameters, default to defaultValue.
  // If defaultValue is not set, default to "error"
  // Note that process.argv elements are:
  //   0 = name of the app executing the process (e.g. node)
  //   1 = name of the js script
  var value = process
    .argv
    .slice(2)
    .find(p => p.match(/(error|warn|info|verbose)/i));

  return (value != null ? value : (defaultValue || "error"));
}


function getHostName() {
  return os.hostname();
}


function nextCloudIsInstalled() {
  return fs.existsSync("/var/www/nextcloud");
}


function executeShellCommand(cmd) {
  // If ending char is a linefeed, then strip it off
  //console.log("EXECUTING " + cmd);
  //return child_process
  //  .execSync(cmd)
  //  .toString()
  //  .replace(/\n$/, "");
  try {
    return child_process
      .execSync(cmd)
      .toString()
      .replace(/\n$/, "");
  }
  catch (ex) {
    logger.error("  ERROR executing shell cmd %s: stdout=%s, stderr=%s", cmd, ex.stdout, ex.stderr);
  }
}


function executeSqlCommand(sql) {
  return executeShellCommand(format(
    "mysql -ss -u{0} -p{1} {2} -e \"{3};\"",
    _configuration.nextcloud.db.username,
    _configuration.nextcloud.db.password,
    "nextcloud", sql));
}


function sendMessageToPhone(familyMember, msg) {
  // Encode the message and build the url to call
  var url = _configuration
    .autoremote.url
    .replace("%AUTOREMOTE_KEY%", familyMember.autoremotekey)
    .replace("%MESSAGE%", encodeURIComponent(msg))
    .replace("%TTL%", PHONE_MESSAGE_EXPIRATION);
		
  executeShellCommand(format("{0} --silent \"{1}\"", _configuration.binaries[PLATFORM].curl, url));
}


function readExistingJsonFile(fileName) {
  if (!fs.existsSync(fileName)) {
    throw format("FILE {0} DOES NOT EXIST", fileName);
  } else {
    return JSON.parse(fs.readFileSync(fileName, "utf8"));
  }
}


function saveJsonFile(fileName, data) {
  fs.writeFileSync(fileName, JSON.stringify(data, null, 2), "utf8");
}


function logFormatter(args) {
  return format("{0} {1}{2}: {3}",
    moment().format("YYYY-MM-DD HH:mm:ss.SSS"),
    args.level,
    " ".repeat(7-args.level.length),
    args.message);
}


function sleep(milliseconds) {
  var start = new Date().getTime();
  for (var i = 0; i < 1e7; i++) {
    if ((new Date().getTime() - start) > milliseconds){
      break;
    }
  }
}


function sendGmail(googleUserName, googlePassword, emailFrom, emailTo, emailSubject, emailBodyText, emailBodyHtml) {
  // Send email. Taken from https://nodemailer.com/about/
  const nodemailer = require("nodemailer");

  let transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: googleUserName,
      pass: googlePassword
    }
  });

  let mailOptions = {
    from: emailFrom,
    to: emailTo,
    subject: emailSubject,
    text: emailBodyText,
    html: emailBodyHtml
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      logger.error("  Error sending email to %s: %s", emailTo, error);
    } else {
      logger.info("  Sent email to %s. id=%s, response=%s", emailTo, info.messageId, info.response);
    }
  });
}


function zipAndEncryptBackup(fileNames, whichBackup, backupPath, includePattern, turnOffNCMaintenanceMode) {
  return new Promise(function (resolve, reject) {
    // fileNames is no longer used, but passed in here in case it might be useful

    // Zip and encrypt the files listed in fileNames,
    // as well as any files listed in ADDITIONAL_FILES_TO_BACKUP.
    // Since tar stores unix file attributes (uid, gid, permissions), 
    // we should do the tar first, and then zip the resulting tarball.
    logger.verbose("zipAndEncryptBackup fileNames=%s", fileNames);

    const FILES_TO_INCLUDE = path.join(__dirname, format("{0}.include-files.txt", whichBackup));
    const FILES_TO_EXCLUDE = path.join(__dirname, format("{0}.exclude-files.txt", whichBackup));
    
    var tarFileName = format("{0}{1}-{2}.tar", 
      backupPath, whichBackup,
      moment().format("YYYYMMDD-HHmmss")); 
    var zipFileName = tarFileName + ".7z";
    var cmdOutput = null;
   
    // Create tarball with all the files we want, then zip with encryption
    cmdOutput = executeShellCommand(
        format("/bin/tar -cvf {0} --files-from {1} --exclude-from={2} {3} > /dev/null",
          tarFileName, FILES_TO_INCLUDE, FILES_TO_EXCLUDE, includePattern));
    logger.verbose("  tar output = %s", cmdOutput);

    if (turnOffNCMaintenanceMode) {
      cmdOutput = executeShellCommand(
        "sudo -u www-data php /var/www/nextcloud/occ maintenance:mode --off");
      logger.info("Turned NextCloud maintenance mode OFF")
    }

    cmdOutput = executeShellCommand(
        format("/usr/bin/7za a -tzip -p{0} -mem=AES256 {1} {2}",
          _configuration.backups.encryptionkey, zipFileName, tarFileName));
    logger.verbose("  zip output = %s", cmdOutput);

    resolve ("junk");
  });
}


function cleanupGoogleDriveFolder(localFolderPath, cmdsToFindOldBackupsToDelete) {
  return new Promise(function (resolve, reject) {
    logger.verbose("cleanupGoogleDriveFolder - %s", localFolderPath);

    // Delete old backups before we do the sync
    try {
      var cmd = cmdsToFindOldBackupsToDelete + " | xargs rm";
      var rmOutput = executeShellCommand(cmd);
      logger.verbose("Cleanup output = %s", rmOutput);
    }
    catch (ex) {
      // Do nothing
    }

    var cmdOutput = executeShellCommand(
      format("rm {0}*tar", localFolderPath));
    logger.verbose("Cleanup tar output = %s", cmdOutput);

    resolve ("junk");
  });
}


function syncToGoogleDrive(localFolderPath, remoteFolderPath) {
  return new Promise(function (resolve, reject) {
    // rclone:
    //   sync 
    //   -- config config_file_name
    //   local_folder_to_sync
    //   remote_folder_to_sync
    // [can append "--dry-run" to not make any changes]
    var cmdOutput = executeShellCommand(
      format("/usr/bin/rclone sync --config {0} {1} remote:{2}",
        "/home/pi/.config/rclone/rclone.conf", 
        localFolderPath, 
        remoteFolderPath));
    logger.verbose("Sync to Google Drive output = %s", cmdOutput);

    resolve ("junk");
  });
}


function deleteFiles(tempFileNamePattern) {
  return new Promise(function (resolve, reject) {
    var cmdOutput = executeShellCommand(
      format("rm {0}", tempFileNamePattern));
    logger.verbose("Cleanup %s output = %s", tempFileNamePattern, cmdOutput);

    resolve ("junk");
  });
}


module.exports = {
  configuration: _configuration,
  today: _today,
  tomorrow: _tomorrow,

  configureLogger: configureLogger,

  getLogLevelFromParameters: getLogLevelFromParameters,
  getHostName: getHostName,
  nextCloudIsInstalled: nextCloudIsInstalled,
  executeShellCommand: executeShellCommand,
  executeSqlCommand: executeSqlCommand,
  sendMessageToPhone: sendMessageToPhone,
  readExistingJsonFile: readExistingJsonFile,
  saveJsonFile: saveJsonFile,
  logFormatter: logFormatter,
  sleep: sleep,
  sendGmail: sendGmail,
  zipAndEncryptBackup: zipAndEncryptBackup,
  cleanupGoogleDriveFolder: cleanupGoogleDriveFolder,
  syncToGoogleDrive: syncToGoogleDrive,
  deleteFiles: deleteFiles
}
