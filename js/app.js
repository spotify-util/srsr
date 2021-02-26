import { credentials } from "./credentials.js";
import * as randomWords from "./random-words.js";
const CURRENT_VERSION = "0.3.3B",
    REFRESH_RATE = { //used to control API rate limiting
        populateAlbumArray: 125,
        populateSongArray: 0,
        addTracksToPlaylist: 150
    },
    QUERY_CHANCE = { //part of the randomness algorithm
        roll: function () { //custom roll func that can be modified as necessary
            return Math.floor(Math.random() * 100) + 1;
        },
        INITIAL_VALS: { //these are never modified
            HIPSTER: 30,
            NEW: 5,
            MAX_OFFSET: 950
        },
        //add rollHipster/rollNew funcs but make it a class!
        HIPSTER: 30, //percent chance of adding hipster tag
        NEW: 5, //percent chance of adding new tag
        MAX_OFFSET: 950, //max offset possible to generate | UPDATED 2021-02-25 after program encountered several 404 errors with 1900 offset
        resetVals: function () {
            this.HIPSTER = this.INITIAL_VALS.HIPSTER;
            this.NEW = this.INITIAL_VALS.NEW;
            this.MAX_OFFSET = this.INITIAL_VALS.MAX_OFFSET;
        },
        increaseUnpopular: function () {
            this.HIPSTER += 50;
            if (this.HIPSTER < 0) this.HIPSTER = 0;
            if (this.HIPSTER > 100) this.HIPSTER = 100;
            //this doesn't increase the max_offset b/c the hipster tag already filters results
            return this.HIPSTER;
        },
        increasePopular: function () {
            this.HIPSTER -= 50;
            if (this.HIPSTER < 0) this.HIPSTER = 0;
            if (this.HIPSTER > 100) this.HIPSTER = 100;
            this.MAX_OFFSET -= 500;
            return this.HIPSTER;
        },
        increaseNew: function () {
            this.NEW += 50;
            if (this.NEW < 0) this.NEW = 0;
            if (this.NEW > 100) this.NEW = 100;
            return this.NEW;
        }
    },
    USER_OPTIONS = {
        allow_explicits: true,
        allow_duplicates: false,
        setOption: function (option_name, option_value) {
            //if(!option_name || !option_value) return false;
            //if(!this[option_name] && !QUERY_CHANCE[option_name]) return false;
            if (this[option_name] !== undefined) return this[option_name] = option_value;
            if (this[option_name] === undefined && QUERY_CHANCE[option_name] !== undefined && option_value === true) return QUERY_CHANCE[option_name]();
        },
        resetOptions: function () {
            this.allow_explicits = true;
            this.allow_duplicates = false;
        }
    };

var customLocalStorage = {
        getContent: function() {
            if(!localStorage.hasOwnProperty('spotify_util') || !JSON.parse(localStorage.getItem('spotify_util')).hasOwnProperty("srsr")) localStorage.setItem('spotify_util', JSON.stringify({ ...JSON.parse(localStorage.getItem('spotify_util')), srsr:{} }));
            return JSON.parse(localStorage.getItem("spotify_util"))["srsr"] || {};
        },
        set: function(key, val) {
            //val can be a js obj, we'll convert it all in here
            let new_storage_obj = { 
                ...JSON.parse(localStorage.getItem("spotify_util")),    //import all of spotiy_util because we are going to update all of spotify_util (want to make sure we dont lose the other keys)
                srsr: {                 //override the srsr key specifically
                    ...this.content,    //carry over everything from srsr
                    [key]:val           //then overwrite the given key with the given value
                } 
            };
            localStorage.setItem("spotify_util", JSON.stringify(new_storage_obj));  //stringify and set the new obj
        }
    },
    database,
    cached_data,
    user_credentials = null,
    global_track_count = 20,
    recursive_operations = {missing_tracks:0, get_album_calls:0},   //for updating progress meter when recursively filtering songs
    current_operation_number = 0;

function callSpotify(url, data) {
    if(!user_credentials) return new Promise((resolve, reject) => reject("no user_credentials"));
    return $.ajax(url, {
        dataType: 'json',
        data: data,
        headers: {
            'Authorization': 'Bearer ' + user_credentials.token
        }
    });
}

function postSpotify(url, json, callback) {
    $.ajax(url, {
        type: "POST",
        data: JSON.stringify(json),
        dataType: 'json',
        headers: {
            'Authorization': 'Bearer ' + user_credentials.token,
            'Content-Type': 'application/json'
        },
        success: function (r) {
            callback(true, r);
        },
        error: function (r) {
            // 2XX status codes are good, but some have no
            // response data which triggers the error handler
            // convert it to goodness.
            if (r.status >= 200 && r.status < 300) {
                callback(true, r);
            } else {
                callback(false, r);
            }
        }
    });
}

function deleteSpotify(url, callback) {
    $.ajax(url, {
        type: "DELETE",
        //data: JSON.stringify(json),
        dataType: 'json',
        headers: {
            'Authorization': 'Bearer ' + user_credentials.token,
            'Content-Type': 'application/json'
        },
        success: function (r) {
            callback(true, r);
        },
        error: function (r) {
            // 2XX status codes are good, but some have no
            // response data which triggers the error handler
            // convert it to goodness.
            if (r.status >= 200 && r.status < 300) {
                callback(true, r);
            } else {
                callback(false, r);
            }
        }
    });
}

/**
 * Shuffles an array and does not modify the original.
 * 
 * @param {array} array - An array to shuffle.
 * @return {array} A shuffled array.
 */
function shuffleArray(array) {
    //modified from https://javascript.info/task/shuffle

    let tmpArray = [...array];

    for (let i = tmpArray.length - 1; i > 0; i--) {
        let j = Math.floor(Math.random() * (i + 1)); // random RESPONSE_INDEX from 0 to i

        // swap elements tmpArray[i] and tmpArray[j]
        // we use "destructuring assignment" syntax to achieve that
        // you'll find more details about that syntax in later chapters
        // same can be written as:
        // let t = tmpArray[i]; tmpArray[i] = tmpArray[j]; tmpArray[j] = t
        [tmpArray[i], tmpArray[j]] = [tmpArray[j], tmpArray[i]];
    }
    return tmpArray;
}

function okToRecursivelyFix(error_obj) {
    //determine if an error object is an api rate issue that can be fixed by calling it again,
    //or an error on our end (such as syntax) that can't be fixed by recalling the api
    console.log("checking if err is ok to recursively fix", error_obj);
    if (error_obj.status >= 429 || error_obj.status == 404) return true;
    else {
        console.log("err NOT ok to recursively fix", error_obj);
        return false
    };
}

function loginWithSpotify() {
    let url = 'https://accounts.spotify.com/authorize?client_id=' + credentials.spotify.client_id +
        '&response_type=token' +
        '&scope=' + encodeURIComponent(credentials.spotify.scopes) +
        '&redirect_uri=' + encodeURIComponent(credentials.spotify.redirect_uri);

    //redirect the page to spotify's login page. after login user comes back to our page with a token in
    //page hash, or, if they're already logged in, a token in customLocalStorage's credentials
    document.location = url;
}

function estimateTimeTotal(track_count) {
    //estimates the amount of time it will take to generate a random playlist with the given amount of songs
    //returns the estimated time in milliseconds
    if (isNaN(track_count) || track_count == 0) return 0;
    let total = 1000; //1sec cushion
    total += track_count * REFRESH_RATE.populateAlbumArray;
    total += Math.ceil(track_count / 20) * REFRESH_RATE.populateSongArray;
    total += Math.ceil(track_count / 100) * REFRESH_RATE.addTracksToPlaylist;
    return total;
}

function estimateTimeRemaining({remaining_tracks, total_tracks = global_track_count} = {}) {
    //estimates the amount of time left until the remaining number of tracks have been added
    //returns the estimated time in milliseconds
    if(isNaN(remaining_tracks) || isNaN(total_tracks)) return 0;
    if (remaining_tracks < 0) remaining_tracks = 0;
    let total = 0;
    total += remaining_tracks * REFRESH_RATE.populateAlbumArray;
    total += Math.ceil(remaining_tracks / 20) * REFRESH_RATE.populateSongArray;
    total += Math.ceil(total_tracks / 100) * REFRESH_RATE.addTracksToPlaylist;
    return total;
}

function oldEstimateTimeRemaining(total_operations, current_operation, track_count = global_track_count) {
    //estimates the amount of time left to perform the remaining number of operations
    //returns the estimated time in milliseconds
    if (isNaN(total_operations) || isNaN(current_operation) || isNaN(track_count)) return 0;
    let total = 0,
        remaining_tracks = total_operations - current_operation;
    if (remaining_tracks < 0) remaining_tracks = 0;
    total += remaining_tracks * REFRESH_RATE.populateAlbumArray;
    total += Math.ceil(track_count / 20) * REFRESH_RATE.populateSongArray;
    total += Math.ceil(track_count / 100) * REFRESH_RATE.addTracksToPlaylist;
    return total;
}

function readableMs(ms) {
    //returns a readable, english version of a time given in ms
    let str = "",
        [hours, mins, secs] = [0, 0, 0];
    hours = Math.floor(ms / 1000 / 60 / 60);
    ms -= (hours * 1000 * 60 * 60);
    mins = Math.floor(ms / 1000 / 60);
    ms -= (mins * 1000 * 60);
    secs = Math.floor(ms / 1000); //floor instead of round to prevent displaying 60sec
    str = `${hours > 0 ? `${hours}${hours==1 ? "hr":"hrs"} `:""}${mins > 0 ? `${mins}${mins==1 ? "min":"mins"} `:""}${secs}${secs==1 ? "sec":"secs"}`;
    return str;
}

const ERROR_OBJ = {
    //100: invalid input
    100: {
        code: 100,
        message: "Please enter a number"
    },
    101: {
        code: 101,
        message: "The natural laws of arithmetic prohibit me from retrieving that many songs"
    },
    102: {
        code: 102,
        message: "You think you're funny or something? Trying to break the program?"
    },
    103: {
        code: 103,
        message: "Retrieving more than 10000 songs currently is possible"
    },
    //500: other
    500: {
        code: 500,
        message: "You need to login with spotify again. Try refreshing the page"
    }
}

function displayError(code) {
    console.log(`Displaying error ${code}`);
}

const progress_bar = new ProgressBar.Line('#progress-bar', {
    color: '#1DB954',
    duration: 1500,
    easing: 'easeOut',
    strokeWidth: 2
});

function progressBarHandler({remaining_tracks, total_tracks = global_track_count, stage = "track"} = {}) {
    //the idea is that each api call we make results in the progress bar updating
    //we need to get the total number of calls that will be made
    let total_operations = total_tracks + Math.ceil(total_tracks / 20) + Math.ceil(total_tracks / 100);
                            //+ recursive_operations.missing_tracks + recursive_operations.get_album_calls;
    //^ see the algorithm used in estimateTimeTotal
    let animate_value = 0,
    estTimeText = "Unknown";

    if(stage == "track") {  //retrieving tracks
        remaining_tracks = total_tracks - remaining_tracks;
        console.log(`setting progress-bar to ${remaining_tracks}/${total_tracks}`);
        //now update the progress bar using the current counter value
        animate_value = remaining_tracks / total_tracks;
        //console.log(`setting progress bar to ${animate_value.toString().substring(0,4)}`);

        //next step is to update the estimated time remaining
        let estTime = estimateTimeRemaining({remaining_tracks:total_tracks-remaining_tracks, total_tracks:total_tracks});
        if (remaining_tracks >= total_tracks) estTimeText = "Done!";
        else estTimeText = readableMs(estTime);
    } else if(stage == "playlist") {    //adding songs to playlist
        
    }

    if(animate_value < progress_bar.value()) animate_value = progress_bar.value();  //prevent the progressbar from ever going backwards
    if(animate_value > 1) animate_value = 1;    //prevent the progressbar from performing weird visuals
    progress_bar.animate(animate_value);

    $("#estimated-time-remaining p").text(`Estimated time remaining: ${estTimeText}`);
}

function oldProgressBarHandler(small_increment = false) {
    /*if (increment_global_counter)*/ current_operation_number++;
    //the idea is that each api call we make results in the progress bar updating
    //we need to get the total number of calls that will be made
    let total_operations = global_track_count + Math.ceil(global_track_count / 20) + Math.ceil(global_track_count / 100)
                            + recursive_operations.missing_tracks + recursive_operations.get_album_calls;
    //^ see the algorithm used in estimateTimeTotal

    //console.log(`setting progress-bar to ${current_operation_number}/${total_operations}`);
    //now update the progress bar using the current counter value
    let animate_value = current_operation_number / total_operations;
    if(small_increment) animate_value = animate_value/3;
    console.log(`setting progress bar to ${animate_value.toString().substring(0,4)}`);
    if(animate_value < progress_bar.value()) animate_value = progress_bar.value();  //prevent the progressbar from ever going backwards
    if(animate_value > 1) animate_value = 1;    //prevent the progressbar from performing weird visuals
    
    progress_bar.animate(animate_value);
    //next step is to update the estimated time remaining
    var estTime = oldEstimateTimeRemaining(total_operations, current_operation_number, global_track_count);
    if (current_operation_number >= total_operations) $("#estimated-time-remaining p").text("Done!");
    else $("#estimated-time-remaining p").text(`Estimated time remaining: ${readableMs(estTime)}`);
}

function getTime() {
    return Math.round(new Date().getTime() / 1000);
}

const loadApp = function () {
    $("#login-page").addClass("hidden");
    $("#main-page").removeClass("hidden");
    setTimeout(function(){
        confirm('You need to refresh the page before proceeding') ? location.reload() : location.reload();
    }, (user_credentials.expires - getTime()) * 1000);
}

async function performAuthDance() {
    // if we already have a token and it hasn't expired, use it,
    if ('user_credentials' in customLocalStorage.getContent()) {
        user_credentials = customLocalStorage.getContent().user_credentials;
    }

    if (user_credentials && user_credentials.expires > getTime()) {
        console.log("found unexpired token!");
        location.hash = ''; //clear the hash just in case (this can be removed later)
        loadApp();
    } else {
        // we have a token as a hash parameter in the url
        // so parse hash

        var hash = location.hash.replace(/#/g, '');
        var all = hash.split('&');
        var args = {};

        all.forEach(function (keyvalue) {
            var idx = keyvalue.indexOf('=');
            var key = keyvalue.substring(0, idx);
            var val = keyvalue.substring(idx + 1);
            args[key] = val;
        });

        if (typeof (args['access_token']) != 'undefined') {
            console.log("found a token in url");
            var g_access_token = args['access_token'];
            var expiresAt = getTime() + 3600;

            if (typeof (args['expires_in']) != 'undefined') {
                var expires = parseInt(args['expires_in']);
                expiresAt = expires + getTime();
            }

            user_credentials = {
                token: g_access_token,
                expires: expiresAt
            }

            callSpotify('https://api.spotify.com/v1/me').then(
                function (user) {
                    user_credentials.user_id = user.id;
                    customLocalStorage.set("user_credentials", user_credentials);
                    location.hash = '';
                    loadApp();
                },
                function (e) {
                    //prompt user to login again
                    location.hash = ''; //reset hash in url
                    console.log(e.responseJSON.error);
                    alert("Can't get user info");
                }
            );
        } else {
            // otherwise, have user login
            console.log("user needs to login!");
        }
    }
}

function generateRandomTrackQuery() {
    const characters = 'abcdefghijklmnopqrstuvwxyz';
    return characters.charAt(Math.floor(Math.random() * characters.length));
}

function generateRandomAlbumQuery() {
    let q = "";
    const characters = 'abcdefghijklmnopqrstuvwxyz';
    switch (Math.floor(Math.random() * 3)) {
        //33.3% chance for 1 letter, 2 letters, random word
        case 0:
            q += characters.charAt(Math.floor(Math.random() * characters.length));
            break;
        case 1:
            q += characters.charAt(Math.floor(Math.random() * characters.length));
            q += characters.charAt(Math.floor(Math.random() * characters.length));
            break;
        case 2:
            q += randomWords.generateRandomWord();
            break;
        default:
            console.log("error in switch-case");
    }

    if (QUERY_CHANCE.roll() <= QUERY_CHANCE.HIPSTER) q += " tag:hipster";
    if (QUERY_CHANCE.roll() <= QUERY_CHANCE.NEW) q += " tag:new";
    return q;
}

function generateRandomOffset() {
    //a random number between 0 and 1900
    //currently offset is capped at 2000 by spotify, but using any number larger than 1900 will sometimes error
    //this gives us a cushion of 100
    return Math.floor(Math.random() * QUERY_CHANCE.MAX_OFFSET);
}

var randomAlbumArray = [],
    randomSongArray = [];

function retrieveRandomAlbums(q = generateRandomAlbumQuery()) {
    //returns two randomly generated albums in an array
    //new algorithm 2020-07-11
    let params = {
        q: q,
        type: 'album',
        limit: 50,
        offset: generateRandomOffset(),
        market: 'from_token'
    };

    //now we have a query that will return only albums. time to call the api, then process our results
    return callSpotify('https://api.spotify.com/v1/search', params).then(res => {
        if (res.albums.items.length <= 1) {
            //not enough albums to return two different ones
            return retrieveRandomAlbums(); //ooh, recursion
        }
        let retrievedAlbums = [];
        function extractAlbum() {
            let randomIndex = Math.floor(Math.random() * res.albums.items.length);
            return res.albums.items[randomIndex];
        }
        while(retrievedAlbums.length < 2) {
            let extractedAlbum = extractAlbum();
            if(retrievedAlbums.includes(extractedAlbum)) continue;
            retrievedAlbums.push(extractedAlbum);
        }
        return retrievedAlbums;
    }).catch(err => {
        console.log("error in retrieveRandomAlbums... attempting to fix recursively", err);
        if (okToRecursivelyFix(err)) return new Promise((resolve, reject) => {
                setTimeout(() => resolve(retrieveRandomAlbums()), 500); //wait half a second before calling api again
            }) //.then(res=>resolve(res)).catch(err=>reject(err)); //this needs to be at the end of every nested promise
            .then(res => res).catch(err => err); //we have to return the vals because we're not in a promise atm, we're in a .catch callback
        else return err; //do something for handling errors and displaying it to the user
    });
}

function retrieveRandomAlbum(q = generateRandomAlbumQuery()) {
    //returns a single, randomly generated album
    //new algorithm 2020-06-30
    let params = {
        q: q,
        type: 'album',
        limit: 50,
        offset: generateRandomOffset(),
        market: 'from_token'
    };

    //now we have a query that will return only albums. time to call the api, then process our results
    return callSpotify('https://api.spotify.com/v1/search', params).then(res => {
        if (res.albums.items.length == 0) {
            //console.log("found a randomAlbum res with no items", res);
            return retrieveRandomAlbum(); //ooh, recursion
        }
        var randomIndex = Math.floor(Math.random() * res.albums.items.length),
            randomAlbum = res.albums.items[randomIndex]; //select a specific song from the album
        //oldProgressBarHandler(true); 
        return randomAlbum;
    }).catch(err => {
        console.log("error in retrieveRandomAlbum... attempting to fix recursively", err);
        if (okToRecursivelyFix(err)) return new Promise((resolve, reject) => {
                setTimeout(() => resolve(retrieveRandomAlbum()), 500); //wait half a second before calling api again
            }) //.then(res=>resolve(res)).catch(err=>reject(err)); //this needs to be at the end of every nested promise
            .then(res => res).catch(err => err); //we have to return the vals because we're not in a promise atm, we're in a .catch callback
        else return err; //do something for handling errors and displaying it to the user
    });
}

function retrieveRandomTrackFromAlbum(album_obj, consider_user_options = false) {
    //pull a track at random from a given full album object
    //if consider_user_options, runs checks against the song in an attempt to ensure a desirable one is found
    let recursive_calls = 0,
    randomIndex = Math.floor(Math.random() * album_obj.tracks.items.length),
    randomTrack = album_obj.tracks.items[randomIndex];
    function recursivelyRetrieveSuitableTrack() {
        recursive_calls++;
        if(recursive_calls > 9) return null;    //if we've tried 10 times and haven't successfully found a song, stop recusrion to prevent infinite loop

        //redefine the randomTrack
        randomIndex = Math.floor(Math.random() * album_obj.tracks.items.length);
        randomTrack = album_obj.tracks.items[randomIndex];
        
        //first things first, check if the track is a duplicate (assuming the user doesn't allow duplicates)
        //no point in checking other stuff first when this would nullify the other checks
        if(!USER_OPTIONS.allow_duplicates && randomSongArray.some(track_obj => track_obj.uri == randomTrack.uri)) {
            //console.log("duplicate found", randomTrack, randomSongArray); //remove this later
            return recursivelyRetrieveSuitableTrack();
        }

        //if the randomly retrieved track is explicit, recursively find one that isn't explicit
        if(!USER_OPTIONS.allow_explicits && !checkIfExplicitAlbum(album_obj))
            //if the randomly retrieved track is explicit, recursively find one that isn't explicit
            if(randomTrack.explicit) return recursivelyRetrieveSuitableTrack();
            
        //add something that picks between the 3 most popular tracks of the album
        
        //if we've made it to this point, we've found a song that meets all the user's specified options
        return randomTrack;
    }

    //if we're not considering user options, just return our track w/o checking it
    if(!consider_user_options) return randomTrack;
    /*else*/ return recursivelyRetrieveSuitableTrack();
}

function checkIfExplicitAlbum(album_obj) {
    //checks all the tracks in an album and returns true if every single song is explicit
    for(const track of album_obj.tracks.items) if(!track.explicit) return false;    //as soon as we find a single song that's not explicit, return
    return true;
}

function resolvePromiseArray(promise_array, callback) {
    Promise.all(promise_array).then((results) => callback(false, results)).catch((err) => {
        console.log(`error found in resolvePromiseArray: `, err);
        callback(true, err);
        //removing ^ that should stop the TypeError: finished_api_calls.forEach is not a function
    });
}

function populateAlbumArray(track_count = 20, array_to_populate = randomAlbumArray, recursion = false) { //possibly change to album_count
    //retrieves {track_count} number of albums and pushes them to the given array

    //new algorithm 2020-07-11
    let pending_api_calls = [];
    return new Promise((resolve, reject) => {
        let i = 0; //even though it's not necessary im still using zero-based index
        let stagger_api_calls = setInterval(() => {
            if (i >= Math.ceil(track_count/2)) { //once we've reached the specified number of tracks
                console.log("stopping API calls");
                clearInterval(stagger_api_calls);
                //resolve all the api calls, then do something with all the resolved calls
                //"return" b/c the code will otherwise continue to make a final api call
                return resolvePromiseArray(pending_api_calls, (err, finished_api_calls) => {
                    console.log(err, finished_api_calls);
                    if (err) reject(finished_api_calls); //finished_api_calls acts as the err msg in this case
                    //finished_api_calls should look like [[album1, album2], [album1, album2], ...]
                    for(const albumArray of finished_api_calls) albumArray.forEach(album => {

                        //so we're going to have a simplified albums object this time
                        //we need to get a random track from each album. only problem is that this involves making ANOTHER api call
                        //fortunately there's a way to call 20 albums at a time, so hopefully that'll reduce the delay a bit

                        if (album == undefined) console.log('the random album is undefined, here it is:', album);

                        array_to_populate.push(album); //push the whole album object                        
                    });
                    console.log("resolving populateAlbumArray promise");
                    resolve(array_to_populate);
                });

            }
            //if we still have more tracks to add:
            //console.log("making api call number " +i);
            pending_api_calls.push(retrieveRandomAlbums());
            i++;
        }, REFRESH_RATE.populateAlbumArray); //100ms is too fast
    });
}

function getMultipleAlbums(album_ids, pid = Math.floor(Math.random() * 999)) {
    //returns array of spotify full album objects
    console.log(`${pid}: attempting to get ${album_ids.length} albums`, album_ids);

    var url = "https://api.spotify.com/v1/albums/";
    return callSpotify(url, {
        ids: album_ids.join(","),
        market: "from_token"
    }).then(res => {
        //oldProgressBarHandler(); //update progressbar
        return res.albums //return
    }).catch(err => {
        console.log("err in getMultipleAlbums... will attempt to recursively fix", err);
        if (okToRecursivelyFix(err)) return new Promise((resolve, reject) => {
                setTimeout(() => resolve(getMultipleAlbums(album_ids, pid)), 500); //wait half a second before calling api again
            }) //.then(res=>resolve(res)).catch(err=>reject(err)); //this needs to be at the end of every nested promise
            .then(res => res).catch(err => err); //we have to return the vals because we're not in a promise atm, we're in a .catch callback
        else return err; //do something for handling errors and displaying it to the user
    });
}

function populateSongArray(album_array = randomAlbumArray) {
    //calls spotify api to retrieve full album information for a given array of albums
    //extracts a single track from each album, then pushes the track to randomSongArray

    //add some checks like whether album_array length is greater than 1, etc?
    let id_array = [];
    //request batches of 20 albums
    for (let i = 0; i < album_array.length; i++) { //for every element in randomAlbumArray
        if (i % 20 == 0) { //this is ok to work when i=0. see below for comments and hopefully you can figure out the logic
            //console.log(i);
            //console.log(id_array);
            id_array.push([]); //if we've filled one subarray with 20 albums, create a new subarray
        }
        id_array[id_array.length - 1].push(album_array[i].id); //go to the last subarray and add the album id
        //repeat until we've gone thru every album in randomAlbumArray
    }
    //console.log(album_array);
    //console.log(id_array);
    let pending_getAlbum_calls = []; //create a promise array

    console.log("starting API batch album calls");
    return new Promise((resolve, reject) => {
        let id_batch_index = 0,
            current_id_batch,
            stagger_api_calls = setInterval(() => {
                current_id_batch = id_array[id_batch_index];
                if (id_batch_index >= id_array.length) { //once we've reached the end of the id_array
                    console.log("stopping API batch calls");
                    clearInterval(stagger_api_calls);
                    //resolve all the api calls, then do something with all the resolved calls
                    //"return" b/c the code will otherwise continue to make anotehr api call
                    return resolvePromiseArray(pending_getAlbum_calls, (err, finished_api_calls) => {
                        // HERE IS WHERE I NEED TO GET A RANDOM TRACK FROM EACH ALBUM
                        console.log(err, finished_api_calls);
                        if (err) reject(finished_api_calls); //finished_api_calls acts as the err msg

                        //work on successful_songs_filtered
                        let successful_songs_added = 0;
                        //so evidently finished_api_calls returns a 2d array, with each subelement being a batch of 20 or less albums
                        //hence the need for two loops
                        for (const album_batch of finished_api_calls) {
                            if (!album_batch) {
                                console.log("no album batch found", finished_api_calls);
                                continue;
                            }
                            for (const single_album_obj of album_batch) {
                                if (!single_album_obj) {
                                    console.log("a single album was missing from this batch", album_batch);
                                    continue;
                                }
                                //if user doesn't allow explicits and the album has only explicit tracks
                                if(!USER_OPTIONS.allow_explicits && checkIfExplicitAlbum(single_album_obj)) {
                                    //console.log("this album is completely explicit", single_album_obj);
                                    continue;
                                }
                                let randomAlbumTrack = retrieveRandomTrackFromAlbum(single_album_obj, true);    //this is the filter
                                if(!randomAlbumTrack) continue; //push nothing, will be fixed later in main
                                randomSongArray.push(randomAlbumTrack);
                                successful_songs_added++;
                            }
                        }
                        /* Old code, before i knew finished_api_calls returned a 2D array
                        finished_api_calls.forEach(album_batch => {
                            if(!album_batch) {  //if no album... maybe change this to a customErrorKey or something?
                                console.log("no album found", finished_api_calls);
                                //return or do something to break function from continuing?
                            } else {
                                //at least, the reason this function exists in the first place
                                randomAlbumTrack = retrieveRandomTrackFromAlbum(album_batch);
                                randomSongArray.push(randomAlbumTrack);
                            }
                        }); */
                        console.log("resolving populateSongArray promise");
                        resolve(successful_songs_added);
                    });
                }
                //if we still have more tracks to add:
                console.log("calling api to add album uri_batch number " + id_batch_index);
                pending_getAlbum_calls.push(getMultipleAlbums(current_id_batch, id_batch_index)); //no .catch() after getMultipleAlbums b/c we want the error to appear in the callback, causing a reject to send to our main() function
                id_batch_index++;
            }, REFRESH_RATE.populateSongArray);
    });
}

function populateSongArrayOld(track_count = 30) {
    if (track_count > 10000) return console.log("track_count is too large");
    //reset the array
    randomSongArray = [];
    var promises = [], //unused at the moment
        pending_api_calls = [];
    return new Promise((resolve, reject) => {
        var i = 0; //even though it's not necessary im still using zero-based index
        var stagger_api_calls = setInterval(() => {
            if (i >= track_count) { //once we've reached the specified number of tracks
                console.log("stopping API calls");
                clearInterval(stagger_api_calls);
                //resolve all the api calls, then do something with all the resolved calls
                //"return" b/c the code will otherwise continue to make anotehr api call
                return resolvePromiseArray(pending_api_calls, (err, finished_api_calls) => {
                    console.log(err, finished_api_calls);
                    if (err) reject(finished_api_calls); //finished_api_calls acts as the err msg in this case
                    finished_api_calls.forEach(res => {
                        //console.log("retreived result");
                        //grab a random song from the res
                        let randomIndex = Math.floor(Math.random() * res.tracks.items.length),
                            randomTrack = res.tracks.items[randomIndex];
                        //run some checks on the song

                        //spotify floors the minute count of their playlists.
                        //for example: a playlist 50min 3sec in length shows up as "50min"
                        //a playlist 50min 58sec in length shows up as "50min"
                        //a playlist 51min 1sec in length shows up as "51min"

                        //if adding this song to the playlist would exceed the requested max duration
                        //if(specs.duration && Math.floor(getCurrentPlaylistDuration() + randomTrack.duration_ms) > specs.duration)

                        //return the random track
                        //console.log("pushing result");
                        //console.log(randomTrack);

                        if (randomTrack == undefined) console.log('randomTrack is undefined, here\'s res:', res);

                        randomSongArray.push(randomTrack); //push the whole track object
                        //we're gonna need to deal with dups some how...
                    });
                    console.log("resolving promise");
                    resolve("resolving from inside resolvePromiseArray");
                });

            }
            //if we still have more tracks to add:
            console.log("making api call number " + i);
            pending_api_calls.push(retrieveRandomSong());
            i++;
        }, 125); //150ms works for requesting 2500 songs, 100ms doesnt
        /* failed attempts:
        do {
            promiseDelay(i++, 500).then(res => {
                promises2.push(retrieveRandomSong());
            });
        } while(i < track_count);
        setInterval(() => {
            console.log(i);
            if(i >= track_count) {
                console.log("ending loop");
                clearInterval();    //stop looping
                resolvePromises();  //resolve every promise
            }
            //always adds one more promise for some reason
            console.log("adding another promise");
            promises.push(promiseDelay(i, 1000));
            i++;
        }, 500);    //dependant off this interval delay
        do {
            promises.push(retrieveRandomSong());
            i++;
        } while(i < track_count);
        */

    });
}

function createPlaylist(params = {
    name: "New Playlist"
}) {
    //create a playlist with the given params, and return the created playlist
    return new Promise((resolve, reject) => {
        var url = "https://api.spotify.com/v1/users/" + user_credentials.user_id + "/playlists";
        postSpotify(url, params, function (ok, playlist) {
            if (ok) resolve(playlist);
            else {
                console.log("err in createPlaylist... will attempt to recursively fix", err);
                if (okToRecursivelyFix(playlist)) return new Promise((resolve, reject) => {
                    setTimeout(() => resolve(createPlaylist(params)), 500); //wait half a second before calling api again
                }).then(res => resolve(res)).catch(err => reject(err)); //this needs to be on the end of every nested promise
                else reject(playlist); //do something for handling errors and displaying it to the user
            }
        });
    });
}

function prepTracksForPlaylistAddition(songArray = randomSongArray) {
    //prepares an array of songs for addition to a spotify playlist
    //by sorting them into arrays of 100 songs each, then returning
    //an array that contains all of those 100-song arrays

    //shuffle the given array, then truncate it
    let shuffledArray = shuffleArray(songArray);
    shuffledArray.length = global_track_count;
    let tmparry = [];
    for (let i = 0; i < shuffledArray.length; i++) { //for every element in songArray
        if (i % 100 == 0) {
            //console.log(i);
            //console.log(uri_array);
            tmparry.push([]); //if we've filled one subarray with 100 songs, create a new subarray
        }
        tmparry[tmparry.length - 1].push(shuffledArray[i].uri); //go to the last subarray and add a song
        //repeat until we've gone thru every song in randomSongArray
    }
    return tmparry;
}

function addTracksToPlaylist(playlist_obj, uri_array) {
    //uri_array needs to be less than 101, please make sure you've checked that before
    //you call this function, otherwise it will err

    //so... what about duplicates?
    var pid = Math.floor(Math.random() * 999);
    console.log(`${pid}: attempting to add ${uri_array.length} tracks to playlist ${playlist_obj.name}`);
    console.log(`${pid}: uri_array:`, uri_array);
    return new Promise((resolve, reject) => {
        //let findDuplicates = arr => arr.filter((item, index) => arr.indexOf(item) != index);
        //var asd = findDuplicates(uri_array).length;
        //if(asd > 0) {
        //    console.log(asd +" duplicates found");
        //    reject({err:"duplicates!!!"});
        //}

        var url = "https://api.spotify.com/v1/users/" + playlist_obj.owner.id + "/playlists/" + playlist_obj.id + '/tracks';
        postSpotify(url, {
            uris: uri_array
        }, (ok, data) => {
            data.pid = pid;
            if (ok) {
                console.log(`${pid}: successfully added ${uri_array.length} tracks to playlist ${playlist_obj.name}`);
                //oldProgressBarHandler();
                resolve(data);
            } else {
                console.log(`${pid} error adding ${uri_array.length} tracks to playlist ${playlist_obj.name}.. attempting to fix recursively...`);
                if (okToRecursivelyFix(data)) return new Promise((resolve, reject) => {
                    setTimeout(() => resolve(addTracksToPlaylist(playlist_obj, uri_array)), 250); //wait half a second before calling api again
                }).then(res => resolve(res)).catch(err => reject(err)); //this needs to be at the end of every nested promise
                else reject(data); //do something for handling errors and displaying it to the user
            }
        });

        //resolve("error: bypassed await...");
    });
}

function addTracksToPlaylistHandler(playlist, uri_array) {
    let pending_addTracksToPlaylist_calls = []; //create a promise array
    console.log("starting API batch addTracksToPlaylist calls");
    return new Promise((resolve, reject) => {
        var uri_batch_index = 0,
            current_uri_batch,
            stagger_api_calls = setInterval(() => {
                current_uri_batch = uri_array[uri_batch_index];
                if (uri_batch_index >= uri_array.length) { //once we've reached the end of the uri_array
                    console.log("stopping API batch addTracksToPlaylist calls");
                    clearInterval(stagger_api_calls);
                    //resolve all the api calls, then do something with all the resolved calls
                    //"return" b/c the code will otherwise continue to make anotehr api call
                    return resolvePromiseArray(pending_addTracksToPlaylist_calls, (err, finished_api_calls) => {
                        console.log(finished_api_calls);
                        if (err) { // do something if i migrate this to its own function
                            console.log("error in API batch add function", finished_api_calls);
                            reject(finished_api_calls);
                        } //else would be redundant?
                        finished_api_calls.forEach(res => {
                            if (!res || !res.snapshot_id) { //if no snapshot... maybe change this to a customErrorKey or something?
                                console.log("no snapshot found, rejecting promise", res);
                                reject(finished_api_calls);
                            }
                        });
                        console.log("resolving addTracksToPlaylistHandler promise");
                        resolve("resolving from inside addTracksToPlaylistHandler");
                    });
                }
                //if we still have more tracks to add:
                console.log("calling api to addTracksToPlaylist uri_batch number " + uri_batch_index);
                pending_addTracksToPlaylist_calls.push(addTracksToPlaylist(playlist, current_uri_batch)); //no .catch() after addTracksToPlaylist b/c we want the error to appear in the callback, causing a reject to send to our main() function
                uri_batch_index++;
            }, REFRESH_RATE.addTracksToPlaylist);
    });
}

async function recursivelyFillArray(song_array = randomSongArray, track_count = global_track_count) {
    //no need to return and resolve promise since this is async, just return any value
    let tmpAlbumArray = [];
    try {
        //fill our tmpAlbumArray with however many songs it needs to fill song_array
        await populateAlbumArray(track_count - song_array.length, tmpAlbumArray, true);
        await populateSongArray(tmpAlbumArray);  //this pushes to the global randomSongArray which is being watched by our main()
    } catch(e) {
        throw e;    //this will go back to our main() function
    } finally {
        return; //resolve the promise
    }
}

async function main(track_count = global_track_count) {
    //reset arrays
    randomAlbumArray = [], randomSongArray = [];
    let tracks_to_receive = track_count,
        album_batch = [];
    try {
        progressBarHandler({remaining_tracks:tracks_to_receive, total_tracks:track_count}); //get a progressbar visual up for the user
        //store the session info in firebase
        let new_session = database.ref('srsr/sessions').push();
        new_session.set({
            sessionTimestamp:new Date().getTime(),
            sessionID:new_session.key,
            //sessionStatus:"pending",
            spotifyUID:user_credentials.user_id,
            songsRequested:track_count,
            userAgent: navigator.userAgent
        }, function (error) {
            if(error) console.log("Firebase error", error);
            else console.log("Firebase data written successfully");
        });
        do {
            album_batch = [];
            console.log("retrieving 20 random albums...");
            await populateAlbumArray(20, album_batch);
            console.log("finished retrieving 20 random albums!", album_batch);
            let succesfully_retrieved_songs = await populateSongArray(album_batch);   //get info for albums, while also filtering songs
            console.log(`successfully received ${succesfully_retrieved_songs} songs`);
            tracks_to_receive-=succesfully_retrieved_songs;
            progressBarHandler({remaining_tracks:tracks_to_receive, total_tracks:track_count});
        } while(tracks_to_receive > 0);
        //console.log("retrieving random albums...");
        //await populateAlbumArray(track_count);
        //console.log("finished retrieving random albums!", randomAlbumArray);
        ////now we need to retrieve a random track from each album
        //console.log("retrieving a random track from each album...");
        //await populateSongArray(randomAlbumArray);
        //console.log("finished retrieving a random track from each album!", randomSongArray);

        console.log("filtering songs based off user's options...");
        //run checks on the playlist array
        while(randomSongArray.length < track_count) {
            recursive_operations.missing_tracks += track_count - randomSongArray.length;
            recursive_operations.get_album_calls++; //both of these are for progressBar information
            console.log(`recursive loop ${recursive_operations.get_album_calls}`);
            //if songs were removed or unable to be added, there will be holes in the playlist
            //this is intentional, so that we can fix them using this function below
            await recursivelyFillArray(randomSongArray, track_count);
        }
        console.log("finished filtering songs");

        //time to add the songs to the playlist
        //first, create the playlist, storing the returned obj locally:
        console.log("creating new playlist...")
        var playlist = await createPlaylist({
            name: "Random Songs",
            description: "A collection of truly random songs retrieved using www.glassintel.com/elijah/programs/srsr"
        });
        console.log("new playlist succesfully created");
        //prep songs for addition (make sure there aren't any extras and put them in subarrays of 100)
        let prepped_uri_array = prepTracksForPlaylistAddition(randomSongArray);
        console.log("finished preparing songs for addition to the playlist!", prepped_uri_array);
        //add them to the playlist
        console.log("adding songs to playlist...");
        await addTracksToPlaylistHandler(playlist, prepped_uri_array);
        console.log("finished adding songs to playlist!");
    } catch (e) {
        console.log("try-catch err", e);
        //"delete" the playlist we just created
        //playlists are never deleted on spotify. see this article: https://github.com/spotify/web-api/issues/555
        deleteSpotify(`https://api.spotify.com/v1/playlists/${playlist.id}/followers`, function (ok, res) { //yay nesting callbacks!!
            if (ok) console.log("playlist succesfully deleted");
            else console.log(`unable to delete playlist, error: ${res}`);
        });
    } finally {
        console.log("execution finished!");
    }

}

$(document).ready(function () {
    console.log(`Running SRSR version ${CURRENT_VERSION}\nDeveloped by Elijah O`);
    firebase.initializeApp(credentials.firebase.config);
    database = firebase.database();
    performAuthDance();
    $("#estimated-time-value").text(readableMs(estimateTimeTotal($("#track-input").val() == "" ? $("#track-input").attr("placeholder") : $("#track-input").val()))); //load default estTime val
});

$("#login-button").click(loginWithSpotify);

$("#track-input").on("propertychange change keyup paste input", function () {
    //update the estimed time whenever the number of tracks is updated
    $("#estimated-time-value").text(readableMs(estimateTimeTotal($(this).val())));
});

//adding a border to the details element
$("details").on("toggle", function () {
    if($(this).attr("open") != undefined) $(this).addClass("details-open");
    else $(this).removeClass("details-open");
});

$("#retrieve-button").click(function () {

    if ($("#track-input").val() == "") global_track_count = 20; //if user left the placeholder of 20
    else global_track_count = parseInt($("#track-input").val(), 10);
    //run checks against track_count
    if (isNaN(global_track_count)) return displayError(100);
    if (global_track_count < 0) return displayError(101);
    if (global_track_count == 0) return displayError(102);
    if (global_track_count > 10000) return displayError(103);

    //run a check to ensure the user is logged in

    //reset all user options to their default
    USER_OPTIONS.resetOptions();
    QUERY_CHANCE.resetVals(); //query_chance b/c we will modify it in the next line

    //update user options
    let user_options_array = $('#user-options input:checkbox').map(function () {
        return {
            name: this.name,
            value: this.checked ? true : false
        };
    });
    for (const option of user_options_array) USER_OPTIONS.setOption(option.name, option.value);

    $("#progress-bar-wrapper").removeClass("hidden"); //show progress bar
    progress_bar.set(0);    //reset progressbar
    current_operation_number = 0, recursive_operations.missing_tracks = 0, recursive_operations.get_album_calls = 0; //reset global counters
    main(global_track_count);
});