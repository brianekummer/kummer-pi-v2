// PTO
// January 2018
//
// Check my PTO in our Cozi family calendar, and send a message to my phone with
// my PTO hours today. If I'm on PTO, then update my Slack status to reflect that.
//
// Command-Line Parameters
// -----------------------
// Syntax:     node pto.js [loglevel]
// Parameters: loglevel...Is optional. Determines the loglevel used:
//                        error|warn|info|verbose (default is "error")
//
// However, this script is configured via a number of environment variables,
// and one way of executing it is as follows:
//   sh -ac '. ./kummer-pi.env; node pto.js verbose'
//
//
// Required NPM Packages
// ---------------------
// - Node fetch......Implements fetch for getting notes
//                   npm install node-fetch
// - MomentJS........For date logic
//                   npm install moment
// - Ical............To simplify working with ICAL files
//                   npm install ical
// - Rrule...........Simplify recurring rules in ical
//                   npm install rrule
// - Winston.........Logging framework
//                   npm install winston


const ICAL_FORMAT = 'YYYYMMDDTHHmmss';

var fetch = require('node-fetch');
var moment = require("moment");
var ical = require ("ical");
var RRule = require('rrule').RRule
var format = require("string-format");
var logger = require("winston");
var path = require("path");
var utils = require(path.join(__dirname, "kummer-utils.js"));

utils.configureLogger(logger, __filename);

// Define an uncaughtException error handler to log if something really bad happens
function uncaughtExceptionHandler(options, err) {
  logger.error("%s", err.stack);
}
process.on('uncaughtException', uncaughtExceptionHandler.bind(null, {exit:true}));

setSlackStatusIfNecessary();
return;


function setSlackStatusIfNecessary() {
  var searchStartDate = utils.today.clone();
  var searchEndDate = searchStartDate.clone().endOf("day");

  // Apparently Cozi has some non-standard stuff that the ical
  // library doesn't like. So we'll read it into a variable 
  // and then manually clean it up before processing it.
  fetch(utils.configuration.family.calendar.url, {
    method: 'get',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  })
  .then(r => r.text())
  .then(calendarData => {
    if (calendarData.match(/vcalendar/i) == null) {
      logger.error("Error reading family calendar");
    } else {
      logger.verbose("Successfully read calendar file, now fixing it");

      // Manually fix (via code) each issue we find with Cozi's calendar
      //  1. Cozi doesn't include the time zone on UNTIL portion of recurring all-day appointments
      calendarData = calendarData.replace(/until=(\d{8}T\d{6})\b/ig, "UNTIL=$1Z");

      // For debugging purposes, save fixed calendar
      //var fs = require("fs");
      //fs.writeFileSync("cozi-fixed.ics", calendarData);

      var calendarEvents = ical.parseICS(calendarData);

      // DEBUGGING
      /*
      for (var k in calendarEvents){
        if (calendarEvents.hasOwnProperty(k)){
          var ev = calendarEvents[k]
          if (ev.summary != undefined)
            logger.verbose("%s: %s-%s", ev.summary, moment(ev.start).format("YYYY-MM-DD HH:mm"), moment(ev.end).format("YYYY-MM-DD HH:mm"));
          if (ev.rrule != undefined)
            logger.verbose("    ev.rrule: %s", ev.rrule);
        }
      }
      */
				
      parseCalendarFile(calendarEvents);
    }
  });
}


function parseCalendarFile(calendarEvents) {
  logger.verbose("In parseCalendarFile");

  var ptoEventsStartingToday = [];
  var ptoStartTime = null;
  var ptoEndTime = null;
  var formattedPtoTodayStartTime = null;
  var formattedPtoTodayEndTime = null;
  var nextWorkingDay = null;
  var slackStatus = "";
  var phonePtoMessage = null;

  // Get all consecutive PTO events starting today 
  ptoEventsStartingToday = getConsecutivePtoEvents(calendarEvents, utils.today);

  // DEBUGGING CODE!!!!
  //ptoEventsStartingToday = [
  //  {
  //    start: "20190131T000000",
  //    end: "201902020T000000",
  //    summary: "Brian PTO"
  //  }
  //];

  if (ptoEventsStartingToday.length > 0) {
    // I am on PTO today :-)
    ptoStartTime = moment(ptoEventsStartingToday[0].start, ICAL_FORMAT);
    ptoEndTime = moment(ptoEventsStartingToday[ptoEventsStartingToday.length-1].end, ICAL_FORMAT);
    formattedPtoTodayStartTime = ptoStartTime.format("HHmm");
    formattedPtoTodayEndTime = (ptoEndTime > utils.tomorrow) ? "2359" : ptoEndTime.format("HHmm");

    slackStatus = buildSlackPtoStatusObject(ptoEventsStartingToday, ptoStartTime, ptoEndTime, getSlackVacationEmoji());
      
    logger.info("PTO today from %s - %s, changing Slack status to %s (expires %s)", formattedPtoTodayStartTime, formattedPtoTodayEndTime, slackStatus.text, slackStatus.expiration);
     
    setSlackStatus(slackStatus);
  } else {
    logger.info("No PTO today, not changing Slack status");
    formattedPtoTodayStartTime = "";
    formattedPtoTodayEndTime = "";
  }

  // Send message to my phone so it knows if I'm on PTO today
  phonePtoMessage = format("today_pto|{0}|{1}|{2}|", 
    moment().format("YYYYMMDDHHmm"), 
    formattedPtoTodayStartTime, 
    formattedPtoTodayEndTime);
  utils.sendMessageToPhone(utils.configuration.family["brian"], phonePtoMessage);
}


function getSlackVacationEmoji() {
  var slackStatusVacationParts = utils.configuration.slack.status.vacation.split("|");

  return slackStatusVacationParts[0].match(/^:.*:$/)
    ? slackStatusVacationParts[0]
    : slackStatusVacationParts[1];
}


function buildSlackPtoStatusObject(ptoEventsStartingToday, ptoStartTime, ptoEndTime, ptoEmoji) {
  var statusText = "";
  var statusExpiration = 0;

  if (ptoStartTime.format("HHmm") > "0800") {
    // PTO starts today after 8:00am, so I'll be at work at least some of this morning.
    // My Outlook addin will have to set this status at the time the PTO starts, using
    // logic very similar to what's below.
  } else {
    // PTO starts at the beginning of today
    statusText = "On PTO ";

    if (ptoEndTime.isSame(utils.today, "day")) {
      statusText += "today";
      statusExpiration = ptoEndTime.unix();
    } else {
      // If PTO does not end at midnight, then ptoEndTime is the day we're
      // returning to work. If PTO ends at midnight, then ptoEndDate is the
      // day AFTER our PTO ends, and we should calculate the next working day.
      nextWorkingDay = (ptoEndTime.format("HHmmss") != "000000")
        ? ptoEndTime
        : addBusinessDays(ptoEndTime.clone().add(-1, "days"), 1);
      var dateFormat = (nextWorkingDay.diff(utils.today, "days") < 7)
        ? "dddd"
        : "dddd, MMM D";
      statusText += "until " + nextWorkingDay.format(dateFormat);
      statusExpiration = nextWorkingDay.unix();
    }
    if (ptoEndTime.format("HHmmss") != "000000") {
      if (statusText == "today")
        statusText += "until";
      statusText += " around " + ptoEndTime.format("h:mm a");
    }
  }

  return {
    text: statusText,
    emoji: ptoEmoji,
    expiration: statusExpiration
  };
}


function getConsecutivePtoEvents(allEvents, searchStartDate) {
  // Get all the consecutive PTO events from this calendar that start
  // on searchStartDate.
  var upcomingPtoEvents = [];
  var previousEvent = null;
  var currentEvent = null;

  // Get list of all upcoming PTO events within next 3 weeks and then
  // sort it by date
  upcomingPtoEvents = 
    getUpcomingPtoEvents(allEvents, searchStartDate, searchStartDate.clone().add(21, 'days'))
    .sort(function (a, b) {
      return b.start < a.start;
    });
  //DebugOutputEvents("Sorted Upcoming PTO Events", upcomingPtoEvents);

  for (var i = 1; i < upcomingPtoEvents.length; i++) {
    previousEvent = upcomingPtoEvents[i-1];
    currentEvent = upcomingPtoEvents[i];

    if (!isConsecutiveBusinessDay(
    moment(previousEvent.start).startOf("day"),
    moment(currentEvent.start).startOf("day"))) {
      // Current event is not consecutive, so delete tail end of the array,
      // NOT including i (the current event). This will leave upcomingPtoEvents
      // with only the consecutive PTO events.
      upcomingPtoEvents = upcomingPtoEvents.slice(0, i);
    }
  }
  //DebugOutputEvents("Consecutive PTO Events", upcomingPtoEvents);

  if (upcomingPtoEvents.length > 0 && upcomingPtoEvents[0].start >= utils.tomorrow) {
    logger.verbose("Is upcoming PTO, but it doesn't start today, starts on %s", moment(upcomingPtoEvents[0].start).format("YYYY-MM-DD HH:mm:ss"));
    upcomingPtoEvents = [];
  }

  return upcomingPtoEvents;
}


function getUpcomingPtoEvents(allEvents, searchStartDate, searchEndDate) {
  // Get all the upcoming PTO events from this calendar that are between
  // searchStartDate and searchEndDate.
  var currentEvent = null;
  var currentEventStart = null;
  var currentEventSummary = '';
  var kummerRecurringId = 0;
  var upcomingPtoEvents = [];

  for (var k in allEvents) {
    currentEvent = allEvents[k];
    currentEventStart = moment(currentEvent.start);
    currentEventEnd = moment(currentEvent.end);
    currentEventSummary = currentEvent.summary;
    if (
      (currentEvent.summary != undefined) &&
      (currentEventStart < searchEndDate) &&
      (currentEventSummary.match(/brian.*(pto|vacation)/i))
    ) {
      if (currentEvent.rrule != null) { // Do NOT use !== here
        addOccurrencesForRecurringEvent(currentEvent, currentEventStart, kummerRecurringId, allEvents);
      } else if ((currentEventStart >= searchStartDate) || (currentEventStart < searchStartDate && currentEventEnd > searchStartDate)) {
        upcomingPtoEvents.push(currentEvent);
      }
    }
  }

  //DebugOutputEvents("Upcoming PTO Events", upcomingPtoEvents);
	
  return upcomingPtoEvents;
}


function DebugOutputEvents(prefix, listOfEvents) {
  listOfEvents
    .forEach(function (e) {
      logger.verbose("%s: %s-%s: %s", 
        prefix, 
        moment(e.start).format("YYYY-MM-DD HH:mm"), 
        moment(e.end).format("YYYY-MM-DD HH:mm"), 
        e.summary);
  });
}


function isConsecutiveBusinessDay(a,b){
  return b.diff(a, "days") == 1
    || (a.weekday() == 5 && b.weekday() == 1 && b.diff(a,"days") == 3);
}


function addBusinessDays(startDate, numDays) {
  var endingDate = startDate.clone();
	
  var i = 0;
  while (i < numDays) {
    endingDate.add(1, "day");
    if (endingDate.day() > 0 && endingDate.day() < 6) {
      i++;
    }
  }

  return endingDate;
}


function addOccurrencesForRecurringEvent(currentEvent, currentEventStart, kummerRecurringId, allEvents) {
  // Add an occurrence of each recurring event, even if it's
  // before our start date, since some of its occurrences could be
  // between our start and end dates.
  //   - I am intentionally not evaluating any event with a RRULE
  //     to see if I should display it or not. Instead, I am adding
  //     every occurrence of the event to allEvents, and
  //     will evaluate each occurrence below.
  //   - Using rrule.between() SHOULD work, but I found bugs, so I am
  //     using .all() and letting later code filter out occurrences
  //     that are not between our start and end dates.
  var currentEventRrules = currentEvent.rrule.all();
  var newEvent = null;
  var isEventExcluded = false;

  // Cloning function (http://stackoverflow.com/questions/7965822/javascript-how-to-clone-an-object)
  // for cloning an event object to add events via RRule
  var cloneOf = (function () {
    function F() {}
    return function (o) {
      F.prototype = o;
      return new F();
    };
  }());

  kummerRecurringId ++;

  currentEventRrules.forEach(function (newDate) {
    logger.verbose("addOccurrencesForRecurringEvent- " + newDate);
    newEvent = cloneOf(currentEvent);
    newEvent.rrule = null; // Prevent from being re-added
    newEvent.kummerRecurringId = kummerRecurringId;
    newEvent.fromRecurring = true;

    // Copy time from the original event
    newEvent.start = new Date(format("{0}T{1}Z", moment(newDate).format('YYYYMMDD'), currentEventStart.format('HHmmss')));

    // Exclude this occurrence if it's in the list of excluded dates
    isEventExcluded =
      (currentEvent.exdate != null) &&
      (currentEvent.exdate.map(function (e) {
        return e;
      }).indexOf(newEvent.start) >= 0);

    if (!isEventExcluded) {
      allEvents = [newEvent].concat(allEvents);
    }
  });
}


function setSlackStatus(slackStatus) {
  // Update my Slack status

  fetch('https://slack.com/api/users.profile.set', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': "Bearer " + utils.configuration.slack.token
    },
    body: format("profile={{'status_text': '{0}', 'status_emoji': '{1}', 'status_expiration': {2}}}", slackStatus.text, slackStatus.emoji, slackStatus.expiration)
  })
  .then(function(result) {
    var resultString = JSON.stringify(result);
    if (result.statusText == "OK") {
      logger.info("Successfully changed my Slack status to %s %s (expires %s)", slackStatus.emoji, slackStatus.text, slackStatus.expiration);
    } else {
      logger.error("Error changing my Slack status to %s %s (expires %s), and this error occurred:\n%s", slackStatus.emoji, slackStatus.text, slackStatus.expiration, resultString);
    }
  })
}
