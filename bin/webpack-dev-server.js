var pathsys = require('path'),
	md5 = require('md5'),
	urlsys = require('url'),
	streamsys = require('stream'),
	mu2 = require('mu2'),
	utils = require('./utils.js'),
	packageRequireHandler = require('package-require-handler'),
	stringConvertor = require('./convertor/string.js'),
	mustacheConvertor = require('./convertor/mustache.js'),
	fileOps = utils.fileOperator;

var contentBase = null,
	webpackResolve,
	currentPath = process.cwd();

// 用来缓存不同工程的配置文件
var projectMapping = {};
// // 用来缓存每个请求对应的依赖关系，对已经分析过的
var requireListCache = {};
var combine = false;
var config = {
	encodeType: 'utf-8',
	responseHeader: {
		'Content-Type': "text/html;charset=UTF-8"
	},
	consts: {
		RequestConst: 'RequestConst'
	}
}

mu2.root = __dirname + '/template';

// 暂不支持
var generateResponse = {
	handle: function (filepath, projectName, isCss) {
		// 这里处理的文件地址已经是经过prefix、extension 检测之后的准备地址了
		// 只要加上当前目录即可拿到准备的文件地址
		filepath = filepath.replace(/prd/, 'src').replace(projectName, '');
		filepath = pathsys.join(contentBase, filepath);

		var fileMd5 = md5(filepath),
			referenceMd5,
			replaceTmpl = "__context.____MODULES['{0}']",
			replaceFilename;

		var content = packageRequireHandler.readFile(filepath).content,
			fullName = pathsys.basename(filepath),
			basepath = pathsys.dirname(filepath),
			extName = pathsys.extname(filepath),
			fileName = fullName.replace(extName, ''),
			references = [],
			imports = content.match(packageRequireHandler.getPatterns().requireRowPattern),
			objData = {
				md5Key: fileMd5,
				fileName: fullName
			};

		if (imports) {
			for (var i = 0, libPath, targetText, moduleCheck; i < imports.length; i++) {
				imports[i].match(packageRequireHandler.getPatterns().pathPattern);
				libPath = RegExp.$1;

				if (packageRequireHandler.getPatterns().modulePattern.test(libPath)) {
					// handle module
					moduleCheck = packageRequireHandler.checkModuleOrLocalFile(libPath);
					libPath = moduleCheck.targetPath;
				} else {
					// handle sub module
					libPath = packageRequireHandler.checkPrefix(libPath, basepath);
					libPath = packageRequireHandler.checkExtensionName(libPath);
				}

				referenceMd5 = md5(libPath);
				replaceFilename = isCss ? '' : replaceTmpl.format(referenceMd5);

				imports[i].match(packageRequireHandler.getPatterns().requireReplacePattern);
				targetText = RegExp.$1;

				content = content.replace(targetText, replaceFilename);
			}
		}
		
		switch(extName) {
			case '.mustache':
				content = mustacheConvertor(content, fileName);
				break;
			case '.string':
				content = stringConvertor(content, fileName);
				break;
		}

		objData.content = content;

		var tmpl = isCss ? 'commonCssTmpl.mustache' : 'commonJSTmpl.mustache';

		var stream = mu2.compileAndRender(tmpl, objData);

		return stream;
	}
}

// 读取工程目录下面的webpack.config.js文件/
var readWebpackConfig = function () {
	//contentBase = 工程根目录，目前支持在project root下执行，比如package_b2c_admin
	var config = pathsys.join(contentBase, 'webpack.config.js');
	var webpackConfig = require(config);

	return webpackConfig.resolve;
}

module.exports = function (options) {
	var md5Pattern = /@.+?\./i,
		onlinePattern = /prd\//,
		projectNamePattern = /(?:\\|\/)?(.+?)(?:\\|\/)/,
		isCss = /\.css/;

	var jsTmpl = 'document.write(\'<script type="text/javascript" src="//q.qunarzz.com/{projectName}/{env}{outputPath}?{suffix}"></script>\');\r\n',
		cssTmpl = '@import url("//q.qunarzz.com/{projectName}/{env}{outputPath}?{suffix}");\r\n';

	contentBase = options.contentBase;
	combine = options.combine;

	webpackResolve = readWebpackConfig();
	packageRequireHandler.setOptions(webpackResolve, contentBase);

	var handledList = {};

    return function (req, res, next) {
		var requireList,
			suffix,
			query = req.query,
			currentDir = process.cwd(),
			pathName = req._parsedUrl.pathname,
			projectName = req.url.match(projectNamePattern),
			projectName = projectName && projectName[1],
			// 这个js是被解析过的，这个时候直接加载该文件的代码内容
			handled = utils.extend.isEmptyObj(query) ? false : true,
			isCssRequest = isCss.test(req.url);

		console.log('package-parser: ' + req.url);

		if (handled && options.fekit) {
			var stream = generateResponse.handle(pathName, projectName, isCssRequest);
			stream.pipe(res, true);
		}
		else if (onlinePattern.test(req.url)) {
			tmpl = isCssRequest ? cssTmpl : jsTmpl;
			requireList = [];
			requireListCache = {};

			//过滤掉线上的工程名和prd路径，保持请求路径和exports下的路径一直
			pathName = '/' + pathName.replace(md5Pattern, '.').replace(projectNamePattern, '').replace(onlinePattern, '');
			suffix = md5(pathName);
			console.log('parsed url: ' + pathName);
			
			if(!options.fekit) {
				req.url = pathName;
				next()
			} else {
				requireList = packageRequireHandler.getFileRequireList(pathName) || [];
				requireListCache[pathName] = true;

				var result = [];
				for (var i = 0, outputPath, env; i < requireList.length; i++) {

					if (requireListCache[outputPath]) {
						continue;
					}

					outputPath = requireList[i].filePath;
					requireListCache[outputPath] = true;

					if (requireList[i].isModule) {
						env = '';
						outputPath = outputPath.slice(contentBase.length + 1).replace(/\\/gm, '/');
					} else {
						env = 'prd/';
						outputPath = outputPath.slice(outputPath.indexOf('src') + 4).replace(/\\/gm, '/');
					}

					result.push(tmpl.format({
						projectName: projectName,
						outputPath: outputPath,
						suffix: suffix,
						env: env
					}));
				}
				
				handledList[suffix] = pathName;

				res.write(result.join(''));
				res.end();	
			}			
		}
		else {
			next();
		}
	}
}