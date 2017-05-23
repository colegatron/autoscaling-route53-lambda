/*******************************************************************************  
 Lambda function which reacts to SNS topics about Autoscaling events.
 Assumptions:
 - SNS topic for autoscaling
 - Topcic events of autoscaling:EC2_INSTANCE_LAUNCH and autoscaling:EC2_INSTANCE_TERMINATE (other events ignored)
 - Autoscaling object has these tags of name TAG_NAME and a valid value as documented

************ Begin README.md excerpt

## Usage
Create an Autoscaling Group Tag called `Route53` with values in any of the formats below. 

**Tag Name**:  `Route53` (defined in TAG_NAME variable)
**Tag value formats**:  
### **Basics and optional parameters**
  * `HostedZoneId:record-name`            Ex. `Z0987654321123:www.example.com`          (assumes CNAME type and TTL of 1)
  * `HostedZoneId:type:record-name`       Ex. `Z0987654321123:CNAME:www.example.com`    (assumes TTL of 1)
  * `HostedZoneId:type:record-name:ttl`   Ex. `Z0987654321123:CNAME:www.example.com:30`

### **Prefix-notation**
  * `HostedZoneId:type:record-name:ttl`   Ex. `Z0987654321123:CNAME:www.#:30`
  * (Example of notation for dns record name prefix. `#` will be replaced by the zone name. This is assumed in Simple Multi-zone format.)
    * `www.#`  -- will be replaced with --> `www.example.com`

### **Simple Multiple zone format**
  * `HostedZoneId1,HostedZoneId2,...:prefix-name`    Ex. `Z0987654321123,Z1234567890123:www.:30`
  * (All zones use the same prefix-name and prefix-name is added to zone name)

### **JSON Multiple zone format**
  * `[<quoted string in format #1-3 above>, ... ]`   Ex. `["Z0987654321123:CNAME:www.example.com:30","Z1234567890123:A:www.#"]`

  **NOTE:** A tag value of <empty string> or `none` is ignored.

************ End README.md excerpt

    By Peter Jones (PeterRJones) https://github.com/PeterRJones/
    Heavily influenced and inspired by Jurg van Vliet (truthtrap): https://github.com/30mhz/autoscaling-route53-lambda

 TODO:
 - support latency routing policies http://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy.html?console_help=true#routing-policy-latency

********************************************************************************/
"use strict";


const AWS  = require('aws-sdk');
const async = require('async');
const util  = require('util');
const debugArguments = false;
const PREFIX_MARKER = '#';
const FIXUP_MARKER = 'fixup';
var AWS_REGION = process.env.AWS_REGION || 'us-west-2';
var TAG_NAME = 'Route53';
var TYPE_REGEX = /A|CNAME/;
var DNS_WEIGHT = 10;
var DEFAULT_TTL = 1;
var DEFAULT_REC_TYPE = 'CNAME';

//
// parses full tag entry string 
// returns null if success, else error object
//
function parseTagEntry (callCtx, tagEntry) {

  var TTL = DEFAULT_TTL;
  var RecordType = DEFAULT_REC_TYPE;
  var useDNSNames = false;
  var RecordName;
  var tokens = tagEntry.split(':');

  // three format options resulting in array of 2, 3 or 4 elements. See syntax notes in comments at top
  if (tokens.length === 0 || tokens.length > 4) {
    return new Error( "ERROR: ASG: " + callCtx.message.name + " tag: '" + TAG_NAME + "' have too few or too many separators : (expecting 2 or 3). 'HostedZoneId:record-name' (assume type CNAME) or 'HostedZoneId:type:record-name' .");
  }

  // determine how many zone we have
  var zoneIds = tokens[0].trim().split(',');
  // callCtx.tagInfo.zoneCount must include previous values from previous calls to parseTagEntry
  callCtx.tagInfo.zoneCount += zoneIds.length;
  if (callCtx.tagInfo.zoneCount < 1 || zoneIds[0] === '' || zoneIds[0] === null) {
      return new Error("ERROR: ASG: " + callCtx.message.name + " tag: '" + TAG_NAME + "' has invalid ZoneId field (expecting Route53 ZoneId(s) separated by commas). Received value: '" + tokens[0] + "'' .");
  } 

  if (tokens.length >= 3) {
    // validate type parameter
    if (tokens[1].match(TYPE_REGEX) === null) {
      return new Error("ERROR: ASG: " + callCtx.message.name + " tag: '" + TAG_NAME + "' has invalid type field (expecting " + TYPE_REGEX.toString() + "). Received value: '" + tokens[1] + "'' .");
    } else {
      RecordType = tokens[1];
    }

    RecordName = tokens[2].trim();

    if (tokens.length === 4) {
      // validate ttl parameter
      var newTTL = parseInt(tokens[3]);
      if (isNaN(newTTL)) {
        return new Error("ERROR: ASG: " + callCtx.message.name + " tag: '" + TAG_NAME + "' has invalid ttl value (expecintg valid integer). Received value: '" + tokens[3] + "'' .");
      } else {
        TTL = newTTL;
      }
    }

  } else { // 2 parameter case
    RecordName = tokens[1].trim();
  }

  // determine if we want ips or dns names based on records type; A=ip, CNAME=dns
  if (RecordType == "A") {
    useDNSNames = false;
  } else {
    useDNSNames = true;
  }

  // setup zoneList array of objects and include default values
  var newZone;
  for (var j = 0; j < zoneIds.length; j++ ) {
    newZone  = { 
      Id: zoneIds[j],
      ZoneName: '',
      Type: RecordType,
      RecordName: RecordName, // may be updated later, when ZoneName and 
      TTL: TTL, 
      useDNSNames: useDNSNames,
      isPrivate: false // default value, determined later
    };

    // mark if we need to adjust RecordName later when ZoneName is known
    if(zoneIds.length > 1 || RecordName[RecordName.length-1] == PREFIX_MARKER) {
      newZone.ZoneName = FIXUP_MARKER;
      newZone.RecordName = RecordName.substring(0, RecordName.length-1);
    }

    callCtx.tagInfo.zoneList.push( newZone);
    console.log("info: parseTagEntry setup added newZone:" + JSON.stringify(newZone));
  }

}

function describeTags(callCtx, next) {
  if (debugArguments) { console.log("info: function: describeTags arguments: " + util.inspect(arguments)); }

  callCtx.autoscaling.describeTags({
    Filters: [{
      Name: "auto-scaling-group",
      Values: [
        callCtx.message.name
      ]
    }, {
      Name: "key",
      Values: [TAG_NAME]
    }],
    MaxRecords: 1
  }, next);
}


function processTags(callCtx, response, next) {
  if (debugArguments) { console.log("info: function: processTags arguments: " + util.inspect(arguments)); }
  console.log("info: processTags callCtx: " + JSON.stringify(callCtx));
  console.log("info: processTags response " + JSON.stringify(response));

  if (response.Tags.length === 0 || response.Tags[0].Value.length === 0 || response.Tags[0].Value == "none") {
    next("Warning: Ignoring message. ASG: " + callCtx.message.name + " does not define tag: '" + TAG_NAME + "' or tag value is empty or 'none'.");
    return;
  }

  var parseError;
  var tagValue =  response.Tags[0].Value.trim();

  // do we have json array ?
  if (tagValue[0] == '[') {
    var arrTags = JSON.parse(tagValue);
    var arrLen  = arrTags.length;

    for (var t = 0; t < arrLen; t++) {
      // call parse routines
      if( (parseError = parseTagEntry(callCtx, arrTags[t])) )  { //assignemnt in if statement intended
        console.log("info: parseTagEntry error: " + parseError + "\ntagValue[" + t + "]: " + JSON.stringify(arrTags[t]));
        next(parseError);
        return;
      }
    }
  }
  else {
    if( (parseError = parseTagEntry(callCtx, tagValue)) ) { // assignment in if statement intended
      console.log("info: parseTagEntry error: " + parseError + "\ntagValue: " + JSON.stringify(tagValue));
      next(parseError);
    }
  }

  next(null, callCtx);
}


function inspectDNSZone(callCtx, zone, next) {
  if (debugArguments) { console.log("info: function: inspectDNSZone arguments: " + util.inspect(arguments)); }
  callCtx.route53.getHostedZone({
    Id: zone.Id
  }, next);        

}


function processDNSInfo(callCtx, zone, data, next) {
  if (debugArguments) { console.log("info: function: processDNSInfo arguments: " + util.inspect(arguments)); }
  console.log("info: processDNSInfo callCtx: " + JSON.stringify(callCtx) + "\nzone: " + JSON.stringify(zone));
  
  console.log("info: processDNSInfo data: " + JSON.stringify(data));
  // Determine if we are internal or public zone and set isPrivate accordingly
  zone.isPrivate = data.HostedZone.Config.PrivateZone;

  // set ZoneName and possibly fixup RecordName entry
  if( zone.ZoneName == FIXUP_MARKER) {
    // this is a case where existing zone.RecordName contains only a prefix at this point. Make it a fqdn name
    zone.RecordName = zone.RecordName + data.HostedZone.Name;
    zone.ZoneName = data.HostedZone.Name;
  }
  else {    
    zone.ZoneName = data.HostedZone.Name;
  }

  next(null);
}


function retrieveInstanceIds(callCtx, zone, next) {
  if (debugArguments) { console.log("info: function: retrieveInstanceIds arguments: " + util.inspect(arguments)); }
  //
  // do UPSERT for LAUNCH action and DELETE for TERMINATE action
  // 
  if (callCtx.message.event === "autoscaling:EC2_INSTANCE_LAUNCH") {

    callCtx.ec2.describeInstances({
      DryRun: false,
      InstanceIds: [callCtx.message.idEC2Instance]
    }, function(describeError, data) {
      if (debugArguments) { console.log("info: function: describeInstances callback arguments: " + util.inspect(arguments)); }

      if( describeError ) {
        console.log("info: retrieveInstanceIds describeError: " + JSON.stringify(describeError));
        next(describeError, null);
      }
      else if (data === null || data.Reservations.length === 0){
        next (new Error( "ERROR: describeInstances callback NoData or Reservations found."), null);
      }

      console.log("info: retrieveInstanceIds data: " + JSON.stringify(data));
      var recordValue = 0;
      if (zone.isPrivate) {
        // use private ips or names
        if (zone.useDNSNames) {
          recordValue = data.Reservations[0].Instances[0].NetworkInterfaces[0].PrivateIpAddresses[0].PrivateDnsName;
        } else {
          recordValue = data.Reservations[0].Instances[0].NetworkInterfaces[0].PrivateIpAddresses[0].PrivateIpAddress;
        }

      } else {
        // use public ips or names
        if (zone.useDNSNames) {
          recordValue = data.Reservations[0].Instances[0].NetworkInterfaces[0].Association.PublicDnsName;
        } else {
          recordValue = data.Reservations[0].Instances[0].NetworkInterfaces[0].Association.PublicIp;
        }
      }

      // prepare Route53 update
      var batch = {
        ChangeBatch: {
          Changes: [{
            Action: 'UPSERT',
            ResourceRecordSet: {
              Name: zone.RecordName ,
              Type: zone.Type,
              SetIdentifier: callCtx.message.idEC2Instance, // id of EC2 instance 
              Weight: DNS_WEIGHT,
              TTL: zone.TTL,
              ResourceRecords: [{
                Value: recordValue
              }]
            }
          }]
        },
        HostedZoneId: zone.Id
      };
      
      next(describeError, batch);
    });


  } else if (callCtx.message.event === "autoscaling:EC2_INSTANCE_TERMINATE") {

    callCtx.route53.listResourceRecordSets({
      HostedZoneId: zone.Id,
      MaxItems: '1',
      StartRecordName: zone.RecordName,
      StartRecordIdentifier: callCtx.message.idEC2Instance, // id of EC2 instance 
      StartRecordType: zone.Type,
    }, function(listError, resourceRecordSets) {
      if (debugArguments) { console.log("info: function: listResourceRecordSets callback arguments: " + util.inspect(arguments)); }

      if (listError) {
        console.log("info: listResourceRecordSets listError: " + JSON.stringify(listError));
        next(listError, null);
      } else {

        console.log("info: listResourceRecordSets callback resourceRecordSets:" + JSON.stringify(resourceRecordSets));
        var batch = {
          ChangeBatch: {
            Changes: [{
              Action: 'DELETE',
              ResourceRecordSet: {
                Name: zone.RecordName,
                Type: zone.Type,
                SetIdentifier: callCtx.message.idEC2Instance, // id of EC2 instance 
                Weight: DNS_WEIGHT,
                TTL: zone.TTL,
                ResourceRecords: [{
                  Value: resourceRecordSets.ResourceRecordSets[0].ResourceRecords[0].Value
                }]
              }
            }]
          },
          HostedZoneId: zone.Id
        };

        next(listError, batch);
      }
    });

  } else {
    console.log("ERROR: received unexpected message, exiting. event: " + callCtx.message.event);
    return new Error("ERROR: retrieveInstanceIds received unexpected message, exiting. event: " + callCtx.message.event);
  }

}

function callChangeRecordSet(callCtx, zone, error, batch)  {
  if (debugArguments) { console.log("info: function: callChangeRecordSet arguments: " + util.inspect(arguments)); }
  console.log("Calling changeResourceRecordSets callCtx=" + JSON.stringify(callCtx) + "\nerror: " + JSON.stringify(error) + "\nzone: " + JSON.stringify(zone) + " batch: " + JSON.stringify(batch));

  if (error) {
    console.error("ERROR: Final async callback (zone=" + JSON.stringify(zone) + ") updateRoute53 received error: " + JSON.stringify(error));
    return;
  } else {

    console.log("Calling changeResourceRecordSets " + 
               " with Action: " + batch.ChangeBatch.Changes[0].Action + 
               " \nfor zone: " + JSON.stringify(zone) +
               " \nand batch: " + JSON.stringify(batch));
    // now start the work
    callCtx.route53.changeResourceRecordSets(batch, function(error, response) {
      if (debugArguments) { console.log("info: function: changeResourceRecordSets callback arguments: " + util.inspect(arguments)); }
      if (error) {
        console.error("ERROR: changeResourceRecordSets received error: " + error);
      } else {
        console.log("SUCCESS: changeResourceRecordSets " + 
                    " action: " + batch.ChangeBatch.Changes[0].Action + 
                    " status: " + response.ChangeInfo.Status + 
                    "\nfor zone: " + JSON.stringify(zone) +
                    "\nfull response:" + JSON.stringify(response));
      }
    });
  }
}

//
// main module entrypoint
//
//
exports.handler = function(inEvent, context) {
  if (debugArguments) { console.log("info: function: exports.handler arguments: " + util.inspect(arguments)); }

  console.log("info: function: " + context.functionName + " version: " + context.functionVersion + " AWS_REGION: " + AWS_REGION + " SNS-message-received: " + JSON.stringify(inEvent));
  
  var message = JSON.parse(inEvent.Records[0].Sns.Message);
  console.log("info: SNS-message-received: " + JSON.stringify(message));
  //
  // short-circut for messages we don't care about 
  if (!((message.Event === "autoscaling:EC2_INSTANCE_LAUNCH") || (message.Event === "autoscaling:EC2_INSTANCE_TERMINATE"))) {
    console.log("info: ignoring message: " + message.Event + " for AutoScalingGroupName: " + message.AutoScalingGroupName);
    return;
  }
  
  var msgContext = {

    message : {
      idEC2Instance: message.EC2InstanceId,
      event: message.Event,
      name: message.AutoScalingGroupName,
      cause: message.Cause
    },
    tagInfo : {
      zoneCount: 0,
      zoneList: [] ,
      /* Array of zones 
      {
          Id: '',
          ZoneName: '',
          Type: DEFAULT_REC_TYPE,
          RecordName: '',
          TTL: DEFAULT_TTL,
          useDNSNames: false
          isPrivate: false
      }       
      */
    },
    route53: new AWS.Route53(),
    autoscaling: new AWS.AutoScaling({ region: AWS_REGION }),
    ec2: new AWS.EC2({ region: AWS_REGION })
  };


  console.log("info: Starting async.waterfall #1 with msgContext: " + JSON.stringify(msgContext));
  async.waterfall([ 
    async.apply(describeTags, msgContext),
    async.apply(processTags, msgContext),
    ],  
    function (error, route53Tags) {
      if (debugArguments) { console.log("info: Final callback for async.waterfall #1 arguments: " + util.inspect(arguments)); }
      if (error) {
        console.error("ERROR: Final callback for async.waterfall #1 collectUpdateRecords received error: " + error);
        return;
      } 

      console.log("Final callback for async.waterfall #1: route53Tags: " + JSON.stringify(route53Tags));
      console.log("Final callback for async.waterfall #1: starting async.waterfall #2 for " + msgContext.tagInfo.zoneCount + " zones. msgContext: " + JSON.stringify(msgContext));
      for (var i = 0; i < msgContext.tagInfo.zoneCount; i++ ) {
        
        // execute async.waterfall #2 (sequential steps) for each zone
        console.log("Starting async.waterfall #2-" + i + " for zone: " + JSON.stringify(msgContext.tagInfo.zoneList[i]));
        async.waterfall([ 
          async.apply(inspectDNSZone, msgContext, msgContext.tagInfo.zoneList[i]),
          async.apply(processDNSInfo, msgContext, msgContext.tagInfo.zoneList[i]),
          async.apply(retrieveInstanceIds, msgContext, msgContext.tagInfo.zoneList[i]),
          ],  
          async.apply(callChangeRecordSet, msgContext, msgContext.tagInfo.zoneList[i]) 
        ); 
      }
    }
  );
  

};