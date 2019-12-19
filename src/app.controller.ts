import { Controller, Get, Param, Headers, HttpService, HttpException, HttpStatus } from '@nestjs/common';
import { AxiosRequestConfig } from 'axios';
import { AppService } from './app.service';
import { tap, map, switchMap } from 'rxjs/operators';
import { Observable, of } from 'rxjs';
import { match } from 'minimatch';
import { connectableObservableDescriptor } from 'rxjs/internal/observable/ConnectableObservable';

var fs = require('fs');
const readline = require('readline');
const crypto = require('crypto');
const PROTOCOL = process.env.PROTOCOL || 'http';
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST;
const LEGACY_SERVER_URL = process.env.LEGACY_SERVER_URL;

const overides = [
  { find: 'firmware.url', replace: 'firmware.url =', type:'line' },
  { find: 'static.autoprovision.1.url', replace: 'static.autoprovision.1.url = '+PROTOCOL+'://'+ HOST+':'+PORT+'/provision/', type:'line'},
  { find: 'static.auto_provision.aes_key_in_file', replace: 'static.auto_provision.aes_key_in_file = 0', type:'line' },
  { find: 'static.auto_provision.update_file_mode', replace: 'static.auto_provision.update_file_mode = 0', type:'line'},
  { find: 'wallpaper_upload.url', replace: 'wallpaper_upload.url = https://s3-us-west-1.amazonaws.com/phones.simpsonlabs/T46S-BGv2.jpg', type:'line'},
  { find: 'phone_setting.backgrounds', replace: 'phone_setting.backgrounds = T46S-BGv2.jpg', type:'line'},
]

const cleanMap = [
  { find: '#', replace: '', type:'line'},
]

const valueFilters = [
  { key: /(account.\d.label)/g , type:'transform', transform: (value, key)=>{ return  value.slice(value.length-4) }},
  { key: /(account.\d.display_name)/g , type:'transform', transform: (value, key)=>{ return  value.slice(value.length-4) }},
  { key: /(linekey.\d.label)/g , type:'transform', transform: (value, key)=>{ return value.includes('Park')? value: "Line " + key.match(/\d/g) }},
]

@Controller('provision')
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly httpService: HttpService
  ) {}

  @Get(':id')
  getBootCfg(@Param() params, @Headers() headers) {
    
    // Split requested file name into mac address and file extention
    const mac = params.id.split('.')

    // Get User-Agent from request headers and set them for upcoming requests.
    const conifg: AxiosRequestConfig = {
      headers: { 'User-Agent': headers['user-agent'] },
      responseType: 'arraybuffer'
    } 

    // If phone request boot file by mac return mac configed boot file.
    if(mac[0].slice(0, 1) != 'y' && mac[1] == 'boot') {
      return `#!version:1.0.0.1

include:config "${mac[0]}.cfg"  
           
overwrite_mode = 0
specific_model.excluded_mode= 1`
    }

    // If phone request mac config file build responsponse for the file.
    if(mac[0].slice(0, 1) != 'y' && mac[1] == 'cfg') {

      var request$ = this.httpService.get(LEGACY_SERVER_URL+mac[0]+'_security.enc', conifg)
      .pipe(
        map(res => {

          // Get encrypted data from response
          let data = Buffer.from(res.data);

          // Convert encryption key to hex and create buffer of it.
          const yea_key_128 = ascii_to_hexa('EKs35XacP6eybA25');
          const yea_key = new Buffer(yea_key_128, 'hex');

          // Decrypt security key using AES 128 ECB no padding
          var decipher = crypto.createDecipheriv('aes-128-ecb', yea_key , Buffer.alloc(0));
          decipher.setAutoPadding(false)
          var ciphertext = Buffer.concat([
            decipher.update(data, 'utf8'),
            decipher.final()
          ]);

          // return decrypted encryption key
          return ciphertext.toString('utf-8')
        }),
        switchMap(key => {
          return this.httpService.get(LEGACY_SERVER_URL+mac[0]+'.boot', conifg)
          .pipe(
            switchMap(res => {

              // Get encrypted config from response
              let data = Buffer.from(res.data);

              // Convert encryption key to hex and create buffer of it.
              const broad_key_128 = ascii_to_hexa(key);
              const broad_key = new Buffer(broad_key_128, 'hex');
              
              // Decrypt config using AES 128 ECB no padding
              var decipher = crypto.createDecipheriv('aes-128-ecb', broad_key , Buffer.alloc(0));
              decipher.setAutoPadding(false)
              var ciphertext = Buffer.concat([
                decipher.update(data, 'utf8'),
                decipher.final()
              ]);

              // return decrypted config to constant, remove comment lines and null values from data.
              return of(ciphertext.toString('utf-8'));
            })
          )
        }),
        map(decrypted => {
          const config = removeBlankLines(patch(decrypted, cleanMap)).replace('\r','\n').split('\n').filter(Boolean);
          return matchTemplateParamerters(config)
        }),
        map(async ported => {
          let res = await ported
          return patch(res.join('\r\n'), overides)
        })
      )
      return request$;

    }

    // If non of the above are true retun 404
    throw new HttpException('NotFound', HttpStatus.NOT_FOUND);
    
  }
}

export async function matchTemplateParamerters(config: string[]) {
  // Read template from filesystem and split into array base off return and newline, don't return blank lines
  const lines = require('fs').readFileSync(__dirname + '/static/merged.cfg', 'utf8').replace('\r','\n').split('\n').filter(Boolean);
  let patched: string[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]    

    // If template line is a comment
    if(line.slice(0,1) == '#') {
      // If template line is the required version line
      if(line.includes('#!version:1')) {
          patched.push(line)
      }
    } else {
      // Split line by equal sign to create key value pairs
      let keyValueIndex: number =  lines[index].indexOf("=");
      let configKey: string = lines[index].slice(0,keyValueIndex).trim();
      let configValue: string = lines[index].slice(keyValueIndex+1).trim();
      let templateKeyAndValuePair =  [configKey, configValue];
  

      // Verify that the key was set.
      if(templateKeyAndValuePair[0]) {
        const foundValue = await findValueInConfig(templateKeyAndValuePair, config);
        patched = patched.concat(foundValue);
      }
    }
  }

  return patched
}

export async function findValueInConfig(templateKeyAndValuePair: string[], config: string[]) {
  let templateKey = templateKeyAndValuePair[0];
  let templateValue: string = '';
  let staticHold: string = '';

  if(templateKeyAndValuePair[1]) {
    templateValue =  templateKeyAndValuePair[1];
  }

  /*
  if(!foundValue.value && keyValue[1]) {
    value = keyValue[1].trim();
  } else {
    value = foundValue.value
  }
  */ 
  if(templateKey.slice(0, 7).includes("static.")) {
    templateKey = templateKey.replace("static.", "");
    staticHold = "static."
  }

  let dynamicMatch = templateKey.match(/\.X\.|\.Y\./g)

  if(dynamicMatch){
    if(dynamicMatch.length == 1) {
      let templateConfig: string[] = [];
      
      for (let index = 0; index < config.length; index++) {
        // Split line by equal sign to create key value pairs
        let keyValueIndex: number =  config[index].indexOf("=");
        let configKey: string = config[index].slice(0,keyValueIndex).trim();
        let configValue: string = config[index].slice(keyValueIndex+1).trim();
        
          
        
        // Verify that the key was set.
        if(configKey) {

          let templateKeySplit = templateKey.split(dynamicMatch[0])
          let regex = templateKeySplit[0]+'\\.\\d\\.'+templateKeySplit[1]
          let configDynamicMatch = configKey.match(new RegExp(regex,'g'));

          if(configDynamicMatch) {
            templateConfig.push(staticHold+configDynamicMatch[0] + ' = '+ await valueFilter(valueFilters, configKey, configValue))        
          }
          
        }

        // Loop config and did not find a match.
        if(index == config.length-1) {
          if(templateConfig.length > 0) {
            return templateConfig
          } else {
            return [ templateKey.replace('.X.', '.1.') +' = ' ];
          }
            
        }
      }

    }
    if(dynamicMatch.length == 2) {
      let templateConfig: string[] = [];
      
      for (let index = 0; index < config.length; index++) {
        // Split line by equal sign to create key value pairs
        let keyValueIndex: number =  config[index].indexOf("=");
        let configKey: string = config[index].slice(0,keyValueIndex).trim();
        let configValue: string = config[index].slice(keyValueIndex+1).trim();
        
          
        
        // Verify that the key was set.
        if(configKey) {

          let templateKeySplitX = templateKey.split(dynamicMatch[0])
          let templateKeySplitY = templateKeySplitX[1].split(dynamicMatch[1])
          let regex = templateKeySplitX[0]+'\\.\\d\\.'+templateKeySplitY[0]+'\\.\\d\\.'+templateKeySplitY[1]
          let configDynamicMatch = configKey.match(new RegExp(regex,'g'));


          if(configDynamicMatch) {
            templateConfig.push(staticHold+configDynamicMatch[0] + ' = '+ await valueFilter(valueFilters, configKey, configValue))        
          }
          
        }

        // Loop config and did not find a match.
        if(index == config.length-1) {
          if(templateConfig.length > 0) {
            return templateConfig
          } else {
            return [ templateKey.replace('.X.', '.1.').replace('.Y.', '.1.') +' = ' ];
          }
            
        }
      }
    }
  } else {
  
    if(templateKey == "security.user_password") {
      let templateConfig: string[] = [];

      for (let index = 0; index < config.length; index++) {
        // Split line by equal sign to create key value pairs
        let keyValueIndex: number =  config[index].indexOf("=");
        let configKey: string = config[index].slice(0,keyValueIndex).trim();
        let configValue: string = config[index].slice(keyValueIndex+1).trim();
    
        // Verify that the key was set.
        if(configKey) {
          if(configKey == templateKey) {
            templateConfig.push(staticHold+templateKey + ' = '+ await valueFilter(valueFilters, templateKey, configValue))
          }
        }

        if(index == config.length-1) {
          if(templateConfig.length > 0) {
            return templateConfig
          }
        }

      }
    } else {
      for (let index = 0; index < config.length; index++) {
        // Split line by equal sign to create key value pairs
        let keyValueIndex: number =  config[index].indexOf("=");
        let configKey: string = config[index].slice(0,keyValueIndex).trim();
        let configValue: string = config[index].slice(keyValueIndex+1).trim();
    
        // Verify that the key was set.
        if(configKey) {
          if(configKey == templateKey) {
            return [ staticHold+templateKey +' = '+ await valueFilter(valueFilters, templateKey, configValue) ];
          }
        }
  
        if(index == config.length-1) {
          return [ templateKey+' = '+ await valueFilter(valueFilters, templateKey, templateValue) ];          
        }
      }
    }
    
  }
}

export function ascii_to_hexa(str)
{
  var arr1 = [];
  for (var n = 0, l = str.length; n < l; n ++) {
    var hex = Number(str.charCodeAt(n)).toString(16);
    arr1.push(hex);
  }
  return arr1.join('');
}

export function patch(data, map)
{
  let patched = data;
  map.forEach(patch => {
    
    !patch.type ? patch.type = 'exact' : patch.type = patch.type
    
    let searchString = patch.find;
    
    let replaceType;
    if(patch.type == 'line') {
      replaceType = 'gm';
      let re = new RegExp('^.*' + searchString + '.*$', replaceType);
      patched = patched.replace(re, patch.replace);
    } else if (patch.type == 'add') {
      patched = patched +'\n'+ patch.replace+'\n';
    }else {
      console.log({searchString: searchString, replace: patch.replace })
      patched = patched.replace(new RegExp(searchString, 'g'), patch.replace);
    }

      
  })

  return patched;
}


export async function valueFilter(filters: any[], matchKey:string, value: string) {
  //console.log('called on:'+ matchKey)
  for (let index = 0; index < filters.length; index++) {
    if(matchKey.match(filters[index].key)) {
      //console.log({matched: matchKey })
      if(filters[index].type == 'transform') {
        return filters[index].transform(value, matchKey)
      }
    }

    if(index == filters.length-1) {
      return value
    }

  }
}


export function removeBlankLines(data)
{
  data = data.replace(/^\s*$(?:\r\n?|\n)/gm, '');
  data = data.replace(/.*\s=\s[\r\n]|.*\s=[\r\n]/gm, '');
  return data;
}